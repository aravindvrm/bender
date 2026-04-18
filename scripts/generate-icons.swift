import AppKit
import Foundation
import CoreText

let args = CommandLine.arguments
let rootArg = args.count > 1 ? args[1] : FileManager.default.currentDirectoryPath
let rootURL = URL(fileURLWithPath: rootArg, isDirectory: true)

let outDir = rootURL.appendingPathComponent("build/icons", isDirectory: true)
let fontURL = rootURL.appendingPathComponent("src/web/src/assets/fonts/Doto-VariableFont_ROND,wght.ttf")
let masterPngURL = outDir.appendingPathComponent("icon-1024.png")

try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

if FileManager.default.fileExists(atPath: fontURL.path) {
  _ = CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
}

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()

let bg = NSColor(calibratedRed: 0.831, green: 0.831, blue: 0.847, alpha: 1.0) // zinc-300
bg.setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 1024, height: 1024), xRadius: 180, yRadius: 180).fill()

let font = NSFont(name: "Doto", size: 700) ?? NSFont.systemFont(ofSize: 700, weight: .heavy)
let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: NSColor(calibratedWhite: 0.04, alpha: 1.0), // near-black
  .paragraphStyle: paragraph,
]
("B" as NSString).draw(
  in: NSRect(x: 0, y: 130, width: 1024, height: 760),
  withAttributes: attrs
)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fputs("Failed to generate icon image data.\n", stderr)
  exit(1)
}

try png.write(to: masterPngURL)
print(masterPngURL.path)
