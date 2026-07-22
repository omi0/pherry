import PherryKit
import SwiftUI

/// The whole docking flow in one sheet: capture a `pherry://pair` link (scan or paste), fill in the
/// control-plane address if the link and the app both lack one, redeem, and land on a success card.
///
/// WHY one view for both entry points: a deep link arrives seeded (`link != nil`) and jumps
/// straight to redeem; the "+" / empty-state path arrives empty and shows the scanner. Converging
/// them here means the redeem, the api-url fallback, and the success haptic are written once. On
/// the Simulator (no camera) the paste field is the whole story — documented in running-locally §7.
struct PairFlowView: View {
    /// A seeded link (deep link) or `nil` (start at capture).
    let link: PairLink?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var step: Step = .capture
    @State private var pasteText = ""
    @State private var apiText = ""
    @State private var showPaste = false

    private enum Step: Equatable {
        case capture
        case needApi(PairLink)
        case redeeming
        case success(String)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                content
            }
            .navigationTitle("Dock a host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { finish() }
                        .foregroundStyle(Theme.muted)
                }
            }
        }
        .onAppear { seedIfNeeded() }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .capture: captureStep
        case let .needApi(pending): apiStep(pending)
        case .redeeming: progressStep
        case let .success(name): successStep(name)
        case let .failed(message): failedStep(message)
        }
    }

    // MARK: - Steps

    private var captureStep: some View {
        VStack(spacing: 18) {
            if ScannerView.isSupported {
                ScannerView { captured($0) }
                    .frame(maxWidth: .infinity)
                    .frame(height: 320)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                            .strokeBorder(Theme.border, lineWidth: 1)
                    )
                Text("Point the camera at the dashboard's Pair phone QR, or run `pherry dock`.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
            } else {
                EmptyState(
                    symbol: "qrcode.viewfinder",
                    title: "No camera here",
                    message: "Paste the pherry:// link from the dashboard's Pair modal or `pherry dock`."
                )
            }

            Button {
                withAnimation { showPaste.toggle() }
            } label: {
                Label(showPaste ? "Hide manual entry" : "Paste a link instead", systemImage: "doc.on.clipboard")
                    .font(.callout)
            }
            .foregroundStyle(Theme.accent)

            if showPaste || !ScannerView.isSupported {
                pasteFields
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }

    private var pasteFields: some View {
        VStack(spacing: 12) {
            TextField("pherry://pair?token=…", text: $pasteText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.mono(13))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.border))
            Button("Continue") { pasteContinue() }
                .buttonStyle(PherryButtonStyle())
                .disabled(pasteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func apiStep(_ pending: PairLink) -> some View {
        VStack(spacing: 16) {
            EmptyState(
                symbol: "link",
                title: "Where's the control plane?",
                message: "This link didn't carry the API address. Enter it once and the app remembers."
            )
            TextField("https://api.pherry.dev", text: $apiText)
                .textFieldStyle(.plain)
                .font(.mono(14))
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.border))
            Button("Dock") {
                guard let url = URL(string: apiText.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
                redeem(pending, apiUrl: url)
            }
            .buttonStyle(PherryButtonStyle())
            .disabled(URL(string: apiText.trimmingCharacters(in: .whitespacesAndNewlines)) == nil)
        }
        .padding(20)
    }

    private var progressStep: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Theme.accent)
            Text("Docking…").font(.callout).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func successStep(_ name: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 54))
                .foregroundStyle(Theme.live)
            Text("Docked \(name)")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text("You'll get a ring when this host needs you.")
                .font(.callout)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Done") { finish() }
                .buttonStyle(PherryButtonStyle())
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failedStep(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.danger)
            Text(message)
                .font(.callout)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Try again") { step = .capture }
                .buttonStyle(PherryButtonStyle())
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Logic

    private func seedIfNeeded() {
        if let link, step == .capture {
            begin(with: link)
        }
    }

    private func captured(_ raw: String) {
        guard let url = URL(string: raw), let parsed = PairLink.parse(url) else { return }
        begin(with: parsed)
    }

    private func pasteContinue() {
        let raw = pasteText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw), let parsed = PairLink.parse(url) else {
            step = .failed("That isn't a valid pherry:// pair link.")
            return
        }
        begin(with: parsed)
    }

    /// Decide whether we can redeem now or must ask for the api url first.
    private func begin(with parsed: PairLink) {
        if let api = parsed.apiUrl ?? model.apiUrl {
            redeem(parsed, apiUrl: api)
        } else {
            step = .needApi(parsed)
        }
    }

    private func redeem(_ parsed: PairLink, apiUrl: URL) {
        step = .redeeming
        Task {
            do {
                try await model.redeem(link: parsed, apiUrl: apiUrl, deviceName: UIDevice.current.name)
                Haptics.success()
                step = .success(PairedHost.defaultName(for: parsed.hostId))
            } catch {
                Haptics.warning()
                step = .failed("Docking failed — the link may be expired. Mint a fresh one with `pherry dock`.")
            }
        }
    }

    private func finish() {
        model.pendingPair = nil
        dismiss()
    }
}
