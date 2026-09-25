#!/bin/bash
# 一键构建 /Applications/任务管理器-N100.app
# 前置：node 22+、swiftc；Electron 可复用本机版项目已安装的 dist
set -e
cd "$(dirname "$0")"

APP_NAME="任务管理器-N100"
BUILD="/tmp/$APP_NAME.app"

# 优先复用本机版项目里的 Electron（避免重复下载）
ELECTRON_DIST=""
for cand in "../TaskManagerApp/node_modules/electron/dist/Electron.app" "./node_modules/electron/dist/Electron.app"; do
  if [ -d "$cand" ]; then ELECTRON_DIST="$(cd "$cand" && pwd)"; break; fi
done
if [ -z "$ELECTRON_DIST" ]; then
  echo "[1/4] 安装 Electron..."
  env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE \
    "$(command -v node || echo node)" "$(npm root -g 2>/dev/null)/../npm/bin/npm-cli.js" install electron@37 --no-fund --no-audit 2>/dev/null \
    || npm install electron@37 --no-fund --no-audit
  ELECTRON_DIST="$(pwd)/node_modules/electron/dist/Electron.app"
else
  echo "[1/4] 复用已有 Electron: $ELECTRON_DIST"
fi

echo "[2/4] 生成应用图标（Swift 程序化绘制 → icns）..."
swiftc -O icon.swift -o /tmp/icongen_n100
/tmp/icongen_n100 /tmp/icon_n100_1024.png
rm -rf /tmp/AppIconN100.iconset /tmp/AppIconN100.icns
mkdir -p /tmp/AppIconN100.iconset
for size in 16 32 64 128 256 512 1024; do
  sips -z $size $size /tmp/icon_n100_1024.png --out "/tmp/AppIconN100.iconset/icon_${size}x${size}.png" >/dev/null
done
cp /tmp/AppIconN100.iconset/icon_32x32.png /tmp/AppIconN100.iconset/icon_16x16@2x.png
cp /tmp/AppIconN100.iconset/icon_64x64.png /tmp/AppIconN100.iconset/icon_32x32@2x.png
cp /tmp/AppIconN100.iconset/icon_256x256.png /tmp/AppIconN100.iconset/icon_128x128@2x.png
cp /tmp/AppIconN100.iconset/icon_512x512.png /tmp/AppIconN100.iconset/icon_256x256@2x.png
cp /tmp/AppIconN100.iconset/icon_1024x1024.png /tmp/AppIconN100.iconset/icon_512x512@2x.png
iconutil -c icns /tmp/AppIconN100.iconset -o /tmp/AppIconN100.icns

echo "[3/4] 组装 APP 壳..."
rm -rf "$BUILD"
# 注意：cp -R 复制 Electron.app 会因 default_app.asar 报 Operation not permitted，必须用 ditto
ditto "$ELECTRON_DIST" "$BUILD"
mkdir -p "$BUILD/Contents/Resources/app"
cp main.js preload.js index.html renderer.js package.json "$BUILD/Contents/Resources/app/"
cp /tmp/AppIconN100.icns "$BUILD/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" \
  -c "Set :CFBundleDisplayName $APP_NAME" \
  -c "Set :CFBundleIdentifier com.local.taskmanager.n100" \
  -c "Set :CFBundleIconFile AppIcon" \
  "$BUILD/Contents/Info.plist"

echo "[4/4] Ad-hoc 签名 + 清除隔离属性 + 安装..."
codesign --force --deep -s - "$BUILD"
xattr -cr "$BUILD"
pkill -f "$APP_NAME.app/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "/Applications/$APP_NAME.app"
mv "$BUILD" "/Applications/$APP_NAME.app"
open "/Applications/$APP_NAME.app"
echo "已安装并启动：$APP_NAME"
