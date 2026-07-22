import SwiftUI

/// The one place the app's look is defined — design tokens as dynamic light/dark `Color`s.
///
/// WHY a single token wall: the phone is the product's face and must feel *kin* to the web
/// dashboard, so the dark values are lifted verbatim from it (`#0E1116` bg, `#5C7CFA` accent, …).
/// Every surface, label, and status dot reads from here rather than hard-coding a hex, so a
/// palette change is one edit and light/dark stay in lockstep. Colors resolve per trait
/// collection via `UIColor`'s dynamic provider, so a single token is correct in both appearances.
enum Theme {
    // MARK: - Surfaces

    /// The app background — the deepest surface (dashboard `#0E1116`).
    static let bg = dynamic(dark: 0x0E1116, light: 0xF6F8FB)
    /// A raised card / row surface.
    static let surface = dynamic(dark: 0x171B21, light: 0xFFFFFF)
    /// A second raised surface (chips, insets, nested cards).
    static let surface2 = dynamic(dark: 0x1E242C, light: 0xEEF1F5)
    /// Hairline separators and card borders.
    static let border = dynamic(dark: 0x2B323B, light: 0xD7DEE7)

    // MARK: - Text

    /// Primary text.
    static let text = dynamic(dark: 0xE6E9EE, light: 0x12161C)
    /// Secondary / supporting text.
    static let muted = dynamic(dark: 0x98A2B0, light: 0x5A6675)

    // MARK: - Accents

    /// The brand indigo — primary actions, links, the `notify` urgency.
    static let accent = dynamic(dark: 0x5C7CFA, light: 0x3B5BDB)
    /// Live / connected green — status dots and the E2EE pill.
    static let live = dynamic(dark: 0x51CF66, light: 0x2F9E44)
    /// Danger / interrupt red — unpair, the `call` urgency, drop states.
    static let danger = dynamic(dark: 0xFF6B6B, light: 0xC92A2A)

    // MARK: - Radii

    /// Card / sheet corner radius.
    static let radius: CGFloat = 10
    /// Small control (chip, dot-pill) corner radius.
    static let radiusSmall: CGFloat = 6

    /// The color an attention `urgency` string maps to: `call` interrupts (danger),
    /// `notify` pushes (accent), everything else digests (muted).
    static func urgencyColor(_ urgency: String) -> Color {
        switch urgency {
        case "call": danger
        case "notify": accent
        default: muted
        }
    }

    /// Build a dynamic `Color` from two 24-bit RGB hex values, one per appearance.
    private static func dynamic(dark: Int, light: Int) -> Color {
        Color(UIColor { trait in
            trait.userInterfaceStyle == .dark ? uiColor(dark) : uiColor(light)
        })
    }

    /// Decode a 24-bit `0xRRGGBB` value into an opaque `UIColor`.
    private static func uiColor(_ hex: Int) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Font {
    /// The monospaced face for refs, ids, and terminal chrome (SF Mono via `.monospaced`).
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}
