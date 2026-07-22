import PherryKit
import SwiftTerm
import SwiftUI
import UIKit

/// Owns the SwiftTerm `TerminalView` and bridges its delegate to the wire.
///
/// WHY a controller object rather than a bare representable: the terminal is fed from an async
/// event stream *and* emits keystrokes/resizes back, so something long-lived must hold the view and
/// translate both directions. SwiftTerm's `TerminalViewDelegate` is a plain (non-isolated) protocol
/// but the view is a `UIView` (main-actor) and every callback arrives on the main thread — so the
/// delegate methods are `nonisolated` and hop through `MainActor.assumeIsolated`, which is sound
/// here precisely because SwiftTerm never calls them off-main.
@MainActor
final class TerminalController: NSObject {
    /// The live SwiftTerm view, handed to SwiftUI by ``SwiftTermView``.
    let terminalView: SwiftTerm.TerminalView

    /// Keystrokes to forward as `session.input`.
    var onData: ((Data) -> Void)?
    /// A local viewport change to forward as `session.resize`.
    var onResize: ((Int, Int) -> Void)?

    override init() {
        terminalView = SwiftTerm.TerminalView(frame: .zero, font: nil)
        super.init()
        terminalView.terminalDelegate = self
        terminalView.nativeBackgroundColor = UIColor(Theme.bg)
        terminalView.nativeForegroundColor = UIColor(Theme.text)
    }

    /// Feed host bytes (a snapshot or live output) into the renderer.
    func feed(_ data: Data) {
        terminalView.feed(byteArray: [UInt8](data)[...])
    }

    /// Mirror a host-driven resize onto the local grid so wrapping stays aligned.
    func resizeLocal(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        terminalView.getTerminal().resize(cols: cols, rows: rows)
    }

    /// The current local grid size (what to subscribe / resize with).
    var size: (cols: Int, rows: Int) {
        let terminal = terminalView.getTerminal()
        return (terminal.cols, terminal.rows)
    }

    /// Show the keyboard (and SwiftTerm's Esc/Tab/Ctrl/arrow accessory bar).
    func focus() {
        _ = terminalView.becomeFirstResponder()
    }
}

// The delegate requirements are non-isolated; SwiftTerm always invokes them on the main thread, so
// `assumeIsolated` is the correct, crash-free bridge to the main-actor callbacks above.
extension TerminalController: TerminalViewDelegate {
    nonisolated func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
        let bytes = Data(data)
        MainActor.assumeIsolated { onData?(bytes) }
    }

    nonisolated func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated { onResize?(newCols, newRows) }
    }

    nonisolated func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    nonisolated func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
    nonisolated func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {}
    nonisolated func bell(source: SwiftTerm.TerminalView) {}
    nonisolated func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {}
    nonisolated func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
    nonisolated func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
}

/// The SwiftUI seat for the SwiftTerm view — it just surfaces the controller's view; all behavior
/// lives in ``TerminalController`` and ``TerminalSession``.
struct SwiftTermView: UIViewRepresentable {
    let controller: TerminalController

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        controller.terminalView
    }

    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {}
}
