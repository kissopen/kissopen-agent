import AppKit

/// The KissOpen mark, still while nothing is happening and turning while agents work.
/// It is drawn as a template image at full strength, so macOS tints it
/// exactly like every other menu bar icon and inverts it while the menu is open.
enum StatusIcon {
    // Room for every angle of the 16 × 15 mark, without clipping or changing the item's width.
    private static let size = NSSize(width: 22, height: 22)
    private static let markSize = NSSize(width: 16, height: 15)

    // Canonical KissOpen SVG geometry: viewBox 13.5 14.5 37 35, stroke width 5.
    // These are the same two contours used by the Desktop menu bar templates.
    private static let contours: [[NSPoint]] = [
        [
            NSPoint(x: 16, y: 17), NSPoint(x: 26, y: 29),
            NSPoint(x: 26, y: 35), NSPoint(x: 16, y: 47),
        ],
        [
            NSPoint(x: 48, y: 17), NSPoint(x: 38, y: 29),
            NSPoint(x: 38, y: 35), NSPoint(x: 48, y: 47),
        ],
    ]

    /// `phase` is the rotation in radians, which advances only while work is in flight.
    static func image(phase: Double, working: Bool) -> NSImage {
        let image = NSImage(size: size, flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            defer { context.restoreGState() }
            context.translateBy(x: size.width / 2, y: size.height / 2)
            context.rotate(by: working ? CGFloat(phase) : 0)
            context.scaleBy(x: markSize.width / 37, y: -markSize.height / 35)
            context.translateBy(x: -32, y: -32)
            NSColor.black.setFill()
            NSColor.black.setStroke()
            for contour in contours {
                let path = NSBezierPath()
                path.move(to: contour[0])
                for point in contour.dropFirst() { path.line(to: point) }
                path.close()
                path.lineJoinStyle = .round
                path.lineWidth = 5
                path.fill()
                path.stroke()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
