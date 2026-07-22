// Pherry app icon generator — a minimal white ferry on an indigo blend, drawn from CoreGraphics
// primitives (hull + two-tier cabin + funnel + waves). Run on macOS to (re)produce the committed
// 1024×1024 asset:
//
//     swift ios/scripts-local/make-icon.swift ios/Pherry/Assets.xcassets/AppIcon.appiconset/icon-1024.png
//
// No SF Symbols (Apple forbids them in icons); no text. Kept tidy here so the mark is reproducible.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let dimension = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()

guard let ctx = CGContext(
    data: nil, width: dimension, height: dimension, bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("no context") }

func rgb(_ hex: Int, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

// Background: a soft vertical indigo blend, #5C7CFA (top) → #3B5BDB (bottom).
let gradient = CGGradient(
    colorsSpace: colorSpace,
    colors: [rgb(0x5C7CFA), rgb(0x3B5BDB)] as CFArray,
    locations: [0, 1]
)!
ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: dimension),
    end: CGPoint(x: 0, y: 0),
    options: []
)

let white = rgb(0xFFFFFF)
let deep = rgb(0x2C46B0) // window cut-outs, a shade under the base

// CoreGraphics is bottom-left origin. The ferry is centered, ~60% of the width.

// Funnel (behind the cabin): a small rounded stack.
ctx.setFillColor(white)
let funnel = CGPath(
    roundedRect: CGRect(x: 590, y: 596, width: 70, height: 118),
    cornerWidth: 16, cornerHeight: 16, transform: nil
)
ctx.addPath(funnel); ctx.fillPath()

// Upper cabin (pilothouse).
let pilot = CGPath(
    roundedRect: CGRect(x: 372, y: 566, width: 300, height: 96),
    cornerWidth: 20, cornerHeight: 20, transform: nil
)
ctx.addPath(pilot); ctx.fillPath()

// Main cabin.
let cabin = CGPath(
    roundedRect: CGRect(x: 300, y: 470, width: 424, height: 110),
    cornerWidth: 22, cornerHeight: 22, transform: nil
)
ctx.addPath(cabin); ctx.fillPath()

// Hull — a wide deck tapering to a smooth keel.
let hull = CGMutablePath()
hull.move(to: CGPoint(x: 236, y: 474))
hull.addLine(to: CGPoint(x: 788, y: 474))
hull.addLine(to: CGPoint(x: 748, y: 402))
hull.addCurve(
    to: CGPoint(x: 276, y: 402),
    control1: CGPoint(x: 512, y: 344),
    control2: CGPoint(x: 512, y: 344)
)
hull.closeSubpath()
ctx.addPath(hull); ctx.fillPath()

// Cabin windows — small deep-indigo cut-outs for a touch of detail.
ctx.setFillColor(deep)
for x in stride(from: 344, through: 632, by: 96) {
    let window = CGPath(
        roundedRect: CGRect(x: CGFloat(x), y: 500, width: 52, height: 52),
        cornerWidth: 12, cornerHeight: 12, transform: nil
    )
    ctx.addPath(window); ctx.fillPath()
}

// Two waves under the hull.
ctx.setStrokeColor(rgb(0xFFFFFF, 0.92))
ctx.setLineCap(.round)
ctx.setLineWidth(16)
for (index, baseY) in [CGFloat(340), CGFloat(300)].enumerated() {
    let wave = CGMutablePath()
    let startX: CGFloat = index == 0 ? 262 : 300
    let endX: CGFloat = index == 0 ? 762 : 724
    wave.move(to: CGPoint(x: startX, y: baseY))
    var x = startX
    var up = true
    let step = (endX - startX) / 4
    while x < endX - 1 {
        let nextX = x + step
        wave.addQuadCurve(
            to: CGPoint(x: nextX, y: baseY),
            control: CGPoint(x: x + step / 2, y: baseY + (up ? 26 : -26))
        )
        x = nextX
        up.toggle()
    }
    ctx.addPath(wave); ctx.strokePath()
}

guard let image = ctx.makeImage() else { fatalError("no image") }
let url = URL(fileURLWithPath: outPath)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("no destination")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("write failed") }
print("wrote \(outPath)")
