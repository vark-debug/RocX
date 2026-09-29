/*
 * RocXBridgeMac.mm — macOS 原生实现:按 bundle id 拉起 Photoshop
 *
 * 纯 UXP 的 shell.openPath 只能走系统文件关联(.jpg 默认是「预览」),无法指定应用。
 * 这里先用 NSWorkspace 解析出 Photoshop 的 app URL,再用该 URL 打开目标图片,
 * 从而强制命中 PS,不依赖 LaunchServices 的默认关联。
 *
 * Apple 文档:
 *   - URLForApplicationWithBundleIdentifier: https://developer.apple.com/documentation/appkit/nsworkspace/1417783-urlforapplicationwithbund
 *   - openURLs:withApplicationAtURL:options:configuration:error:
 *
 * Apache 2.0
 */
#import "RocXBridge.h"

#import <AppKit/AppKit.h>

static NSString* const kPhotoshopBundleId = @"com.adobe.Photoshop";

OpenFileResult OpenFileInPhotoshopForPlatform(const char* utf8Path) {
    if (!utf8Path || utf8Path[0] == '\0') {
        return OpenFileResult{false, "empty path"};
    }

    @autoreleasepool {
        NSString* nsPath = [NSString stringWithUTF8String:utf8Path];
        if (!nsPath) {
            return OpenFileResult{false, "path is not valid UTF-8"};
        }
        if (![[NSFileManager defaultManager] fileExistsAtPath:nsPath]) {
            return OpenFileResult{false, "file not found"};
        }
        NSURL* fileURL = [NSURL fileURLWithPath:nsPath];
        if (!fileURL) {
            return OpenFileResult{false, "invalid file URL"};
        }

        NSWorkspace* ws = [NSWorkspace sharedWorkspace];

        // PS 未安装时直接失败,让 UXP 侧走 shell.openPath fallback
        NSURL* psURL = [ws URLForApplicationWithBundleIdentifier:kPhotoshopBundleId];
        if (!psURL) {
            return OpenFileResult{false, "Photoshop is not installed"};
        }

        NSError* err = nil;
        BOOL ok = [ws openURLs:@[ fileURL ]
                 withApplicationAtURL:psURL
                              options:NSWorkspaceLaunchDefault
                       configuration:@{}
                             error:&err];
        if (ok) {
            return OpenFileResult{true, ""};
        }

        const char* desc = err.localizedDescription.UTF8String;
        return OpenFileResult{
            false,
            desc ? std::string(desc) : std::string("failed to open file in Photoshop"),
        };
    }
}
