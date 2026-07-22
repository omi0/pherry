import SwiftUI
import VisionKit

/// A thin SwiftUI wrapper over VisionKit's `DataScannerViewController`, tuned to read one QR.
///
/// WHY VisionKit: docking is "point the phone at the dashboard's QR", and `DataScannerViewController`
/// gives a live camera with QR detection for free. It is unavailable on the Simulator (no camera)
/// and when permission is denied — the pair flow always offers the paste fallback, so this view can
/// stay narrowly about the happy camera path. It reports the *scanned string* upward; parsing into a
/// `PairLink` stays in the flow so both entry paths converge on one place.
struct ScannerView: UIViewControllerRepresentable {
    /// Called with each newly recognised barcode payload string.
    let onScan: (String) -> Void

    /// Whether this device can actually scan (camera present + authorized).
    static var isSupported: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: false,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        try? scanner.startScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    /// Bridges the scanner delegate to the `onScan` closure, deduping repeated reads of the same QR.
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScan: (String) -> Void
        private var seen = Set<String>()

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                guard case let .barcode(barcode) = item,
                      let value = barcode.payloadStringValue,
                      !seen.contains(value) else { continue }
                seen.insert(value)
                onScan(value)
            }
        }
    }
}
