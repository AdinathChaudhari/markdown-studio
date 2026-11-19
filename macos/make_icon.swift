// Draws the app icon with CoreGraphics only (no fonts, no downloads).
// Usage: swift make_icon.swift <out.iconset>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func render(_ px: Int) -> CGImage {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)

    func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
        CGColor(colorSpace: cs, components: [r, g, b, a])!
    }

    // Soft neutral rounded square, ~824 pt inside the 1024 canvas.
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0, 0, 0, 0.28))
    ctx.setFillColor(rgb(0.90, 0.91, 0.92))
    ctx.addPath(tilePath); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(tilePath); ctx.clip()
    let grad = CGGradient(colorsSpace: cs, colors: [rgb(0.95, 0.96, 0.97), rgb(0.84, 0.85, 0.87)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    ctx.restoreGState()

    // White page with folded top-right corner (CG origin is bottom-left).
    let pw: CGFloat = 500, ph: CGFloat = 640, fold: CGFloat = 130
    let px0 = 512 - pw / 2, py0 = 512 - ph / 2
    let page = CGMutablePath()
    page.move(to: CGPoint(x: px0, y: py0))
    page.addLine(to: CGPoint(x: px0 + pw, y: py0))
    page.addLine(to: CGPoint(x: px0 + pw, y: py0 + ph - fold))
    page.addLine(to: CGPoint(x: px0 + pw - fold, y: py0 + ph))
    page.addLine(to: CGPoint(x: px0, y: py0 + ph))
    page.closeSubpath()
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: rgb(0, 0, 0, 0.22))
    ctx.setFillColor(rgb(1, 1, 1))
    ctx.addPath(page); ctx.fillPath()
    ctx.restoreGState()
    ctx.setStrokeColor(rgb(0.78, 0.79, 0.81)); ctx.setLineWidth(3)
    ctx.addPath(page); ctx.strokePath()

    let flap = CGMutablePath()
    flap.move(to: CGPoint(x: px0 + pw - fold, y: py0 + ph))
    flap.addLine(to: CGPoint(x: px0 + pw - fold, y: py0 + ph - fold))
    flap.addLine(to: CGPoint(x: px0 + pw, y: py0 + ph - fold))
    flap.closeSubpath()
    ctx.setFillColor(rgb(0.90, 0.91, 0.93))
    ctx.addPath(flap); ctx.fillPath()
    ctx.setStrokeColor(rgb(0.78, 0.79, 0.81))
    ctx.addPath(flap); ctx.strokePath()

    // The "M down-arrow" mark, geometry from the logo SVG (viewBox 24):
    //   M6 15.5v-7l3 3.5 3-3.5v7   and   M15.5 8.5v5m0 0 2.2-2.4m-2.2 2.4-2.2-2.4
    // Mark spans x 6..17.7, y 8.5..15.5; centre (11.85, 12). SVG y points down.
    let k: CGFloat = 25
    let cx: CGFloat = 512, cy: CGFloat = 540
    func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: cx + (x - 11.85) * k, y: cy - (y - 12) * k) }
    ctx.setStrokeColor(rgb(0.16, 0.18, 0.22))
    ctx.setLineWidth(1.5 * k)
    ctx.setLineCap(.round); ctx.setLineJoin(.round)
    let m = CGMutablePath()
    m.move(to: P(6, 15.5)); m.addLine(to: P(6, 8.5)); m.addLine(to: P(9, 12))
    m.addLine(to: P(12, 8.5)); m.addLine(to: P(12, 15.5))
    ctx.addPath(m); ctx.strokePath()
    let a = CGMutablePath()
    a.move(to: P(15.5, 8.5)); a.addLine(to: P(15.5, 13.5))
    a.move(to: P(15.5, 13.5)); a.addLine(to: P(17.7, 11.1))
    a.move(to: P(15.5, 13.5)); a.addLine(to: P(13.3, 11.1))
    ctx.addPath(a); ctx.strokePath()

    // A few quiet text lines under the mark.
    ctx.setStrokeColor(rgb(0.80, 0.81, 0.84)); ctx.setLineWidth(16)
    for (i, w) in [CGFloat(340), 340, 220].enumerated() {
        let y = py0 + 170 - CGFloat(i) * 44
        ctx.move(to: CGPoint(x: px0 + 80, y: y)); ctx.addLine(to: CGPoint(x: px0 + 80 + w, y: y))
    }
    ctx.strokePath()
    return ctx.makeImage()!
}

guard CommandLine.arguments.count > 1 else { FileHandle.standardError.write(Data("usage: make_icon <dir>\n".utf8)); exit(2) }
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let specs: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in specs {
    let url = dir.appendingPathComponent(name + ".png") as CFURL
    let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, render(px), nil)
    guard CGImageDestinationFinalize(dest) else { exit(1) }
}
