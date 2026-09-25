// 程序化绘制 macOS 风格图标：深色渐变圆角方块 + 上升柱状图 + 趋势线
import AppKit

let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
guard let ctx = NSGraphicsContext.current?.cgContext else { exit(1) }

// ---- 阴影 + 深色渐变底（Big Sur 圆角方块：824/1024，圆角 184）----
let frame = NSRect(x: 100, y: 100, width: 824, height: 824)
let squircle = NSBezierPath(roundedRect: frame, xRadius: 184, yRadius: 184)

ctx.saveGState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.30)
shadow.shadowBlurRadius = 36
shadow.shadowOffset = NSSize(width: 0, height: -22)
shadow.set()
ctx.setFillColor(NSColor.black.cgColor)
ctx.addPath(squircle.cgPath)
ctx.fillPath()
ctx.restoreGState()

// 底色渐变：深蓝黑
let bg = NSGradient(colors: [
    NSColor(srgbRed: 0.145, green: 0.161, blue: 0.216, alpha: 1),
    NSColor(srgbRed: 0.055, green: 0.063, blue: 0.090, alpha: 1)
])!
bg.draw(in: squircle, angle: -90)

// 顶部内侧高光（玻璃质感）
ctx.saveGState()
squircle.addClip()
let hi = NSGradient(colors: [
    NSColor.white.withAlphaComponent(0.10),
    NSColor.white.withAlphaComponent(0.0)
])!
hi.draw(in: NSRect(x: 100, y: 624, width: 824, height: 300), angle: -90)
ctx.restoreGState()

// 1px 内描边（细腻轮廓）
ctx.saveGState()
squircle.addClip()
squircle.lineWidth = 3
NSColor.white.withAlphaComponent(0.08).setStroke()
squircle.stroke()
ctx.restoreGState()

// ---- 柱状图：4 根上升圆角柱（青绿→绿→琥珀→橙，区别于本机版蓝绿）----
let colors: [NSColor] = [
    NSColor(srgbRed: 0.20, green: 0.85, blue: 0.75, alpha: 1),    // 青绿
    NSColor(srgbRed: 0.25, green: 0.82, blue: 0.45, alpha: 1),    // 绿
    NSColor(srgbRed: 1.00, green: 0.72, blue: 0.25, alpha: 1),    // 琥珀
    NSColor(srgbRed: 1.00, green: 0.55, blue: 0.20, alpha: 1)     // 橙
]
// 基线区域：x 272..752
let barW: CGFloat = 74
let gap: CGFloat = 22
let heights: [CGFloat] = [180, 268, 356, 448]
let baseY: CGFloat = 300
for (i, h) in heights.enumerated() {
    let x = 272 + CGFloat(i) * (barW + gap)
    let rect = NSRect(x: x, y: baseY, width: barW, height: h)
    let bar = NSBezierPath(roundedRect: rect, xRadius: 26, yRadius: 26)
    let g = NSGradient(colors: [
        colors[i].blended(withFraction: 0.25, of: .white)!,
        colors[i]
    ])!
    g.draw(in: bar, angle: -90)
    // 柱顶柔光
    ctx.saveGState()
    bar.addClip()
    let g2 = NSGradient(colors: [.white.withAlphaComponent(0.28), .white.withAlphaComponent(0.0)])!
    g2.draw(in: NSRect(x: x, y: baseY + h - 40, width: barW, height: 40), angle: -90)
    ctx.restoreGState()
}

// ---- 趋势线：白色细线爬升 + 末端亮点 ----
ctx.saveGState()
let line = NSBezierPath()
line.lineWidth = 14
line.lineCapStyle = .round
line.lineJoinStyle = .round
line.move(to: NSPoint(x: 276, y: 560))
line.curve(to: NSPoint(x: 452, y: 640), controlPoint1: NSPoint(x: 352, y: 560), controlPoint2: NSPoint(x: 400, y: 632))
line.curve(to: NSPoint(x: 610, y: 596), controlPoint1: NSPoint(x: 505, y: 648), controlPoint2: NSPoint(x: 560, y: 620))
line.curve(to: NSPoint(x: 752, y: 700), controlPoint1: NSPoint(x: 668, y: 570), controlPoint2: NSPoint(x: 716, y: 660))
NSColor.white.withAlphaComponent(0.92).setStroke()
line.stroke()
// 末端光点
let dot = NSBezierPath(ovalIn: NSRect(x: 752 - 26, y: 700 - 26, width: 52, height: 52))
NSColor.white.withAlphaComponent(0.25).setFill()
dot.fill()
let dot2 = NSBezierPath(ovalIn: NSRect(x: 752 - 13, y: 700 - 13, width: 26, height: 26))
NSColor.white.setFill()
dot2.fill()
ctx.restoreGState()

img.unlockFocus()

// ---- 写出 PNG（透明底）----
guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"))
print("icon written")
