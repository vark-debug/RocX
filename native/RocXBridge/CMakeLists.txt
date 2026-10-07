# RocXBridge — Adobe UXP Hybrid Plugin (uxpaddon)
#
# 产物落盘约定由 vite-uxp-plugin 写死：它只认 <projectRoot>/public-hybrid，
# 并在 buildStart 时把 public-hybrid/* 拷进 dist/*（见 node_modules/vite-uxp-plugin/lib/index.js
# 的 copyHybridBinaries）。所以 POST_BUILD 必须输出到 public-hybrid/{mac,win}/<arch>/，
# 不能输出到本目录下的 dist/（那样 ccx 里不会带上 uxpaddon）。
cmake_minimum_required(VERSION 3.15)
project(RocXBridge VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

# Hybrid Plugin SDK headers (Adobe UXP Hybrid Plugin SDK)
set(UXP_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/uxp-hybrid-sdk")
set(UXP_SDK_INCLUDE_DIRS
    "${UXP_SDK_DIR}/src/api"
    "${UXP_SDK_DIR}/src/utilities"
)

# 跨平台源文件
set(COMMON_SOURCES
    src/RocXBridge.cpp
    "${UXP_SDK_DIR}/src/utilities/UxpAddon.cpp"
)

if(APPLE)
    list(APPEND COMMON_SOURCES src/RocXBridgeMac.mm)
elseif(WIN32)
    list(APPEND COMMON_SOURCES src/RocXBridgeWin.cpp)
endif()

add_library(RocXBridge SHARED ${COMMON_SOURCES})

target_include_directories(RocXBridge PRIVATE ${UXP_SDK_INCLUDE_DIRS})

if(APPLE)
    target_link_libraries(RocXBridge PRIVATE
        "-framework AppKit"
        "-framework CoreServices"
        "-framework CoreFoundation"
        "-framework Foundation"
    )
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64")
        set(UXP_PLATFORM_DIR "mac/arm64")
    else()
        set(UXP_PLATFORM_DIR "mac/x64")
    endif()
elseif(WIN32)
    target_link_libraries(RocXBridge PRIVATE
        shell32
        advapi32
    )
    set(UXP_PLATFORM_DIR "win/x64")
endif()

# .dylib / .dll → .uxpaddon，并复制到 vite-uxp-plugin 约定的 public-hybrid 布局
set(UXP_ADDON_OUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../public-hybrid/${UXP_PLATFORM_DIR}")
add_custom_command(TARGET RocXBridge POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${UXP_ADDON_OUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy
        "$<TARGET_FILE:RocXBridge>"
        "${UXP_ADDON_OUT_DIR}/RocXBridge.uxpaddon"
    COMMENT "Copying uxpaddon to public-hybrid/${UXP_PLATFORM_DIR}/"
)
