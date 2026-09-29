/*
 * RocXBridgeWin.cpp — Windows 原生实现:按注册表路径拉起 Photoshop
 *
 * 流程:
 *   1) 试 HKLM\SOFTWARE\Adobe\Photoshop\<ver>\ApplicationPath(ver 7.0 → 30.0)
 *   2) 失败时试 HKCU
 *   3) 全部失败退到 CoCreateInstance + IApplicationAssociationRegistration 查询 .jpg UserChoice
 *   4) 拿到 PS 路径后 ShellExecuteExW 启动
 *
 * Apache 2.0
 */
#include "RocXBridge.h"
#include <windows.h>
#include <shobjidl.h>
#include <string>
#include <cstdio>
#include <cstring>

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
 * 退到 IApplicationAssociationRegistration COM 接口查询 .jpg UserChoice
 * Win10+ 可用
 */
static bool queryJpgUserChoice(std::wstring* outExePath) {
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
    hr = pAAR->QueryCurrentDefault(L".jpg", AT_FILEEXTENSION,
        ALE_USER_APPLICATION_REGISTRATION_FLAGS_NONE, &appProgid);
    if (FAILED(hr) || !appProgid) {
        pAAR->Release();
        return false;
    }

    // 从 ProgID 取 LocalServer / shell\open\command
    wchar_t progKey[256];
    std::_snwprintf_s(progKey, _TRUNCATE,
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
    *outExePath = cmd.substr(firstQ + 1, secondQ - firstQ - 1);
    return true;
}

OpenFileResult OpenFileInPhotoshopForPlatform(const char* utf8Path) {
    if (!utf8Path || utf8Path[0] == '\0') {
        return OpenFileResult{false, "empty path"};
    }

    // 1) 注册表扫描(7.0 → 30.0,覆盖 PS CS5 → ... → 2025+)
    std::wstring psPath;
    bool found = false;
    for (float v = 7.0f; v <= 30.0f; v += 0.1f) {
        if (readPhotoshopPathFromRegistry(HKEY_LOCAL_MACHINE, v, &psPath)) { found = true; break; }
        if (readPhotoshopPathFromRegistry(HKEY_CURRENT_USER, v, &psPath)) { found = true; break; }
    }

    // 2) 退到 UserChoice COM 查询
    if (!found && !queryJpgUserChoice(&psPath)) {
        return OpenFileResult{false, "Photoshop not found in registry or via UserChoice"};
    }

    // 3) ShellExecuteExW 启动
    std::wstring wPath = wideFromUtf8(utf8Path);

    SHELLEXECUTEINFOW sei = { 0 };
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = L"open";
    sei.lpFile = psPath.c_str();
    sei.lpParameters = wPath.c_str();
    sei.nShow = SW_SHOWNORMAL;

    if (!ShellExecuteExW(&sei)) {
        char errMsg[64];
        std::snprintf(errMsg, sizeof(errMsg), "ShellExecuteExW failed (err=%lu)", GetLastError());
        return OpenFileResult{false, errMsg};
    }

    return OpenFileResult{true, ""};
}