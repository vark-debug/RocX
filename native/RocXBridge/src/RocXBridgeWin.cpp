/*
 * RocXBridgeWin.cpp — Windows 原生实现:按注册表路径拉起 Photoshop
 *
 * 流程:
 *   1) 试 HKLM\SOFTWARE\Adobe\Photoshop\<ver>\ApplicationPath(ver 12.0 → 200.0)
 *   2) 失败时试 HKCU
 *   3) 仍失败退到 Adobe CC 默认安装路径扫描(CC 2018 ~ 2026+)
 *      —— PR 受限 session 读不到注册表,这层兜底是主力路径
 *   4) 再失败扫 C:\Program Files\Adobe\ 下所有子目录 —— 绿色版(Portable /
 *      非 CC 安装)不写注册表且目录名不标准,靠枚举兜底
 *   5) 再失败退到 CoCreateInstance + IApplicationAssociationRegistration 查询 .psd UserChoice
 *   6) 校验结果确实是 Photoshop.exe(文件关联可能指向 WPS/照片/预览)
 *   7) 拿到 PS 路径后 ShellExecuteExW 启动
 *
 * Apache 2.0
 */
#include "RocXBridge.h"
#include <windows.h>
#include <shobjidl.h>
#include <string>
#include <cstdio>
#include <cstring>
#include <cstdarg>  // _snwprintf_s (CRT global, VS2026 移除了 std:: 别名)

// 把 wstring 转成 UTF-8
static std::string utf8FromWide(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(),
        nullptr, 0, nullptr, nullptr);
    std::string utf8(sizeNeeded, 0);
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(),
        &utf8[0], sizeNeeded, nullptr, nullptr);
    return utf8;
}

// 把 UTF-8 转成 wstring
static std::wstring wideFromUtf8(const char* utf8) {
    if (!utf8) return std::wstring();
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    std::wstring wide(len, 0);
    MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], len);
    wide.pop_back();  // 去掉末尾 '\0'
    return wide;
}

/**
 * 读注册表 Photoshop\ApplicationPath,ver 形如 7.0 / 8.0 / ... / 30.0
 * @return true if found, output *outPath 写入 ps.exe 所在目录
 */
static bool readPhotoshopPathFromRegistry(HKEY rootKey, float ver, std::wstring* outPath) {
    char subkey[128];
    std::snprintf(subkey, sizeof(subkey), "SOFTWARE\\Adobe\\Photoshop\\%.1f", ver);
    std::wstring wSubkey(subkey, subkey + std::strlen(subkey));

    HKEY hKey = nullptr;
    LSTATUS st = RegOpenKeyExW(rootKey, wSubkey.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &hKey);
    if (st != ERROR_SUCCESS) return false;

    wchar_t valueBuf[MAX_PATH] = { 0 };
    DWORD valueSize = sizeof(valueBuf);
    DWORD valueType = 0;
    st = RegQueryValueExW(hKey, L"ApplicationPath", nullptr, &valueType,
        (LPBYTE)valueBuf, &valueSize);
    RegCloseKey(hKey);
    if (st != ERROR_SUCCESS || valueType != REG_SZ) return false;

    *outPath = std::wstring(valueBuf);
    return true;
}

/**
 * 判断某个可执行文件路径是不是 Photoshop。
 * 用于校验注册表/UserChoice/硬编码路径拿到的到底是 PS,而不是 WPS/照片/预览。
 */
static bool isPhotoshopExe(const std::wstring& exePath) {
    if (exePath.empty()) return false;
    // 文件名(去掉路径)应为 Photoshop.exe
    size_t sep = exePath.find_last_of(L"\\/");
    std::wstring filename = (sep == std::wstring::npos) ? exePath : exePath.substr(sep + 1);
    return _wcsicmp(filename.c_str(), L"Photoshop.exe") == 0;
}

/**
 * Adobe Creative Cloud 默认安装路径扫描(CC 2018 ~ 2026+)。
 *
 * 为什么需要这层兜底:PR 启动的进程受沙箱/受限 session 限制,读不到
 * HKLM\SOFTWARE\Adobe\Photoshop\<ver>\ApplicationPath,注册表分支会 100% 走不通
 * (见 docs/cpp-hybrid-build.md 的已知问题)。
 * launcher.ps1 有同样的硬编码列表,这里保持一致。
 */
static bool findPhotoshopByHardcodedPath(std::wstring* outExePath) {
    static const wchar_t* kCandidates[] = {
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2023\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2022\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2021\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop 2020\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop CC 2019\\Photoshop.exe",
        L"C:\\Program Files\\Adobe\\Adobe Photoshop CC 2018\\Photoshop.exe",
    };
    for (const wchar_t* c : kCandidates) {
        if (::GetFileAttributesW(c) != INVALID_FILE_ATTRIBUTES) {
            *outExePath = c;
            return true;
        }
    }
    return false;
}

/**
 * 从目录名里提取年份,用于在多个候选中挑最新的一个。
 * "Adobe Photoshop 2024" -> 2024;"PS2024" -> 2024;识别不到返回 0。
 */
static int ExtractYearScore(const std::wstring& dirName) {
    for (size_t i = 0; i + 4 <= dirName.size(); ++i) {
        if (dirName[i] < L'0' || dirName[i] > L'9') continue;
        if (dirName[i + 1] < L'0' || dirName[i + 1] > L'9') continue;
        if (dirName[i + 2] < L'0' || dirName[i + 2] > L'9') continue;
        if (dirName[i + 3] < L'0' || dirName[i + 3] > L'9') continue;
        int y = (dirName[i] - L'0') * 1000 + (dirName[i + 1] - L'0') * 100 +
                (dirName[i + 2] - L'0') * 10 + (dirName[i + 3] - L'0');
        if (y >= 1990 && y <= 2099) {
            return y;
        }
    }
    return 0;
}

/**
 * 扫描 Adobe 安装目录下的所有子目录,找 Photoshop.exe。
 *
 * 为什么需要:绿色版(Portable / 非 Creative Cloud 安装)不写注册表,
 * 目录名也不标准("PS2024"、"PS 2024 绿色版"、任意自定义名),
 * 固定候选列表覆盖不到。这里按目录枚举兜底,只认 Adobe 根目录下的
 * 一级/二级子目录,不做全盘扫描(避免卡顿和误扫)。
 */
static bool findPhotoshopInAdobeDir(const wchar_t* adobeRoot, std::wstring* outExePath) {
    if (::GetFileAttributesW(adobeRoot) == INVALID_FILE_ATTRIBUTES) {
        return false;
    }

    std::wstring bestPath;
    int bestScore = -1;

    WIN32_FIND_DATAW fd = { 0 };
    std::wstring rootPattern = std::wstring(adobeRoot) + L"\\*";
    HANDLE hRoot = ::FindFirstFileW(rootPattern.c_str(), &fd);
    if (hRoot == INVALID_HANDLE_VALUE) {
        return false;
    }

    do {
        if (fd.cFileName[0] == L'.') continue;
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;

        std::wstring subDir = std::wstring(adobeRoot) + L"\\" + fd.cFileName;

        // 一级子目录:<root>\<dir>\Photoshop.exe
        auto consider = [&](const std::wstring& exe) {
            if (::GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) return;
            int score = ExtractYearScore(fd.cFileName);
            if (score > bestScore) {
                bestScore = score;
                bestPath = exe;
            }
        };
        consider(subDir + L"\\Photoshop.exe");

        // 二级子目录:<root>\<dir>\<dir2>\Photoshop.exe
        WIN32_FIND_DATAW fd2 = { 0 };
        std::wstring subPattern = subDir + L"\\*";
        HANDLE hSub = ::FindFirstFileW(subPattern.c_str(), &fd2);
        if (hSub != INVALID_HANDLE_VALUE) {
            do {
                if (fd2.cFileName[0] == L'.') continue;
                if ((fd2.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
                consider(subDir + L"\\" + fd2.cFileName + L"\\Photoshop.exe");
            } while (::FindNextFileW(hSub, &fd2));
            ::FindClose(hSub);
        }
    } while (::FindNextFileW(hRoot, &fd));
    ::FindClose(hRoot);

    if (bestPath.empty()) {
        return false;
    }
    *outExePath = bestPath;
    return true;
}

/**
 * 退到 IApplicationAssociationRegistration COM 接口查询文件关联(默认打开程序)
 * Win10+ 可用
 *
 * 注意:必须查 .psd 而不是 .jpg —— .jpg 的默认关联常是「照片/WPS/预览」,
 * 查到后拿到的根本不是 Photoshop,会静默用错应用打开图片(且还返回 ok=true)。
 * .psd 的默认关联才精确指向 Photoshop。
 */
static bool queryUserChoiceExe(const wchar_t* extension, std::wstring* outExePath) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        return false;
    }
    IApplicationAssociationRegistration* pAAR = nullptr;
    hr = CoCreateInstance(CLSID_ApplicationAssociationRegistration, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&pAAR));
    if (FAILED(hr) || !pAAR) {
        return false;
    }

    LPWSTR appProgid = nullptr;
    // VS2026 / SDK 26100: QueryCurrentDefault 第三参数改为 ASSOCIATIONLEVEL,
    // 旧 API_NAME 是 ALE_USER_APPLICATION_REGISTRATION_FLAGS_NONE,值等同于 AL_EFFECTIVE。
    hr = pAAR->QueryCurrentDefault(extension, AT_FILEEXTENSION,
        AL_EFFECTIVE, &appProgid);
    if (FAILED(hr) || !appProgid) {
        pAAR->Release();
        return false;
    }

    // 从 ProgID 取 LocalServer / shell\open\command
    wchar_t progKey[256];
    // VS2026 / MSVC 14.51 移除了 std::_snwprintf_s,改用 CRT 全局 _snwprintf_s
    _snwprintf_s(progKey, _TRUNCATE,
        L"SOFTWARE\\Classes\\%ls\\shell\\open\\command", appProgid);
    CoTaskMemFree(appProgid);

    HKEY hKey = nullptr;
    LSTATUS st = RegOpenKeyExW(HKEY_CURRENT_USER, progKey, 0, KEY_READ, &hKey);
    if (st != ERROR_SUCCESS) {
        st = RegOpenKeyExW(HKEY_LOCAL_MACHINE, progKey, 0, KEY_READ, &hKey);
    }
    if (st != ERROR_SUCCESS) {
        pAAR->Release();
        return false;
    }

    wchar_t cmdBuf[MAX_PATH * 2] = { 0 };
    DWORD cmdSize = sizeof(cmdBuf);
    st = RegQueryValueExW(hKey, nullptr, nullptr, nullptr, (LPBYTE)cmdBuf, &cmdSize);
    RegCloseKey(hKey);
    pAAR->Release();
    if (st != ERROR_SUCCESS) return false;

    // cmdBuf 形如 "C:\Program Files\Adobe\...\Photoshop.exe" "%1"
    // 取第一个引号内的路径
    std::wstring cmd = cmdBuf;
    size_t firstQ = cmd.find(L'"');
    if (firstQ == std::wstring::npos) return false;
    size_t secondQ = cmd.find(L'"', firstQ + 1);
    if (secondQ == std::wstring::npos) return false;
    std::wstring exePath = cmd.substr(firstQ + 1, secondQ - firstQ - 1);

    // 校验拿到的是不是 Photoshop —— 文件关联可能指向 WPS/照片/预览,
    // 那样会用错应用打开图片,必须拒绝。
    if (!isPhotoshopExe(exePath)) {
        return false;
    }
    *outExePath = exePath;
    return true;
}

OpenFileResult OpenFileInPhotoshopForPlatform(const char* utf8Path) {
    if (!utf8Path || utf8Path[0] == '\0') {
        return OpenFileResult{false, "empty path"};
    }

    // 1) 注册表扫描:遍历 Adobe 已发布过的所有 PS 主版本号。
    // Adobe 自 PS 2026 起改用 "200.0" 这种"年份/10"的整型键名(200.0 = 2026),
    // 旧版以 7.0/8.0/.../30.0 形式存储。
    // 浮点累加 v += 0.1f 到 200 误差累积大且 RegOpenKeyEx 调用 1900+ 次,
    // 这里直接枚举已知版本号,稳且快。
    static const float kKnownVersions[] = {
        // CS5 / CS6 / CC 2013~2014
        12.0f, 13.0f,
        // CC 2015 ~ CC 2019(版本号 15~20)
        15.0f, 16.0f, 17.0f, 18.0f, 19.0f, 20.0f,
        // 2020 ~ 2025(版本号 21~25 / Adobe 偶有跳号,补 26~30 兼容)
        21.0f, 22.0f, 23.0f, 24.0f, 25.0f, 26.0f, 27.0f, 28.0f, 29.0f, 30.0f,
        // 2026+(键名 200.0)
        200.0f
    };
    std::wstring psPath;
    bool found = false;
    for (size_t i = 0; i < sizeof(kKnownVersions) / sizeof(kKnownVersions[0]); ++i) {
        const float v = kKnownVersions[i];
        std::wstring dir;
        if (readPhotoshopPathFromRegistry(HKEY_LOCAL_MACHINE, v, &dir) ||
            readPhotoshopPathFromRegistry(HKEY_CURRENT_USER, v, &dir)) {
            // 注册表里存的是 Photoshop.exe 所在目录,拼上文件名并确认存在
            std::wstring exe = dir;
            if (!exe.empty() && exe.back() != L'\\' && exe.back() != L'/') {
                exe += L'\\';
            }
            exe += L"Photoshop.exe";
            if (::GetFileAttributesW(exe.c_str()) != INVALID_FILE_ATTRIBUTES) {
                psPath = exe;
                found = true;
                break;
            }
        }
    }

    // 2) 注册表读不到时,退到 Adobe CC 默认安装路径扫描。
    //    PR 的受限 session 读不到 HKLM\...\ApplicationPath,注册表分支常 100% 走不通。
    if (!found) {
        found = findPhotoshopByHardcodedPath(&psPath);
    }

    // 3) 再扫 Adobe 安装目录下的所有子目录 —— 绿色版(Portable / 非 CC 安装)
    //    不写注册表、目录名也不标准,固定候选列表覆盖不到,靠枚举兜底。
    if (!found) {
        found = findPhotoshopInAdobeDir(L"C:\\Program Files\\Adobe", &psPath);
    }
    if (!found) {
        found = findPhotoshopInAdobeDir(L"C:\\Program Files (x86)\\Adobe", &psPath);
    }

    // 4) 最后退到 UserChoice COM 查询(.psd 关联,精确指向 Photoshop)
    if (!found) {
        found = queryUserChoiceExe(L".psd", &psPath);
    }

    if (!found) {
        return OpenFileResult{false,
            "Photoshop not found (checked registry, C:\\Program Files\\Adobe\\, "
            "and .psd file association). Is Photoshop installed?"};
    }

    // 4) 兜底校验:拿到的必须是 Photoshop.exe,否则会静默用错应用打开
    if (!isPhotoshopExe(psPath)) {
        return OpenFileResult{false, "resolved executable is not Photoshop.exe"};
    }

    // 3) ShellExecuteExW 启动
    std::wstring wPath = wideFromUtf8(utf8Path);

    // 剥离 "\\?\" 扩展长度前缀 —— UXP 的 nativePath 常带这个前缀,
    // 直接交给 ShellExecuteExW 通常打不开(它按普通 Win32 路径解析)。
    if (wPath.rfind(L"\\\\?\\", 0) == 0) {
        wPath = wPath.substr(4);
    }

    // 文件存在性校验 —— 不存在就别拉起 Photoshop 了,直接报错。
    if (::GetFileAttributesW(wPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
        return OpenFileResult{false, "file not found"};
    }

    // 路径含空格时必须加引号,否则 ShellExecuteExW 会把它拆成多个 argv,
    // Photoshop 收到残缺路径(工程路径如 C:\Users\Zhang San\... 很容易踩到)。
    std::wstring quotedPath = L"\"";
    quotedPath += wPath;
    quotedPath += L"\"";

    SHELLEXECUTEINFOW sei = { 0 };
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = L"open";
    sei.lpFile = psPath.c_str();
    sei.lpParameters = quotedPath.c_str();
    sei.nShow = SW_SHOWNORMAL;

    if (!ShellExecuteExW(&sei)) {
        char errMsg[64];
        std::snprintf(errMsg, sizeof(errMsg), "ShellExecuteExW failed (err=%lu)", GetLastError());
        return OpenFileResult{false, errMsg};
    }

    return OpenFileResult{true, ""};
}