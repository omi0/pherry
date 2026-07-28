import PherryKit
import SwiftUI

/// The whole docking flow in one sheet: capture a `pherry://pair` link (scan or paste), fill in the
/// control-plane address if the link and the app both lack one, pass the ``PairPolicy`` trust gate,
/// redeem, and land on a success card.
///
/// WHY one view for both entry points: a deep link arrives seeded (`link != nil`); the "+" /
/// empty-state path arrives empty and shows the scanner. Converging them here means the redeem,
/// the api-url fallback, the M24 confirm card, and the success haptic are written once. A seeded
/// deep link **never** auto-redeems — it always stops at the confirm card, because the app was
/// handed that URL unsolicited. On the Simulator (no camera) the paste field is the whole story —
/// documented in running-locally §7.
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
        case confirm(PairLink, URL, [PairPolicy.Warning])
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
        case let .confirm(pending, api, warnings): confirmStep(pending, api: api, warnings: warnings)
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
            Text("https only — http works for localhost during development.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            Button("Dock") {
                guard let url = enteredApiUrl else { return }
                confirmOrRedeem(pending, apiUrl: url)
            }
            .buttonStyle(PherryButtonStyle())
            .disabled(enteredApiUrl == nil)
        }
        .padding(20)
    }

    /// The M24 confirm card — the user sees what they are about to trust before any redeem.
    private func confirmStep(_ pending: PairLink, api: URL, warnings: [PairPolicy.Warning]) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.shield")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.accent)
            Text("Dock \(PairedHost.defaultName(for: pending.hostId))?")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.text)
            VStack(alignment: .leading, spacing: 8) {
                confirmRow(label: "Host", value: pending.hostId)
                confirmRow(label: "Control plane", value: PairPolicy.origin(of: api))
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.border))
            ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                warningRow(warning)
            }
            Button("Dock") {
                redeem(pending, apiUrl: api, allowRepin: warnings.contains { warning in
                    if case .repinsHostKey = warning { return true } else { return false }
                })
            }
            .buttonStyle(PherryButtonStyle())
            Button("Cancel") { step = .capture }
                .font(.callout)
                .foregroundStyle(Theme.muted)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func confirmRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.footnote).foregroundStyle(Theme.muted)
            Text(value).font(.mono(13)).foregroundStyle(Theme.text)
        }
    }

    private func warningRow(_ warning: PairPolicy.Warning) -> some View {
        let (symbol, text, color): (String, String, Color) = switch warning {
        case let .newApiOrigin(origin):
            ("info.circle", "First time docking through \(origin) — make sure you expect this address.", Theme.muted)
        case let .repinsHostKey(hostId):
            ("exclamationmark.triangle.fill", "This replaces the pinned key for \(hostId). Only continue if you re-docked that host yourself.", Theme.danger)
        }
        return Label(text, systemImage: symbol)
            .font(.footnote)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
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
            fingerprintCard
            Button("Done") { finish() }
                .buttonStyle(PherryButtonStyle())
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The S3 safety number: the host's `pherry dock` ceremony prints the same fingerprint and
    /// asks the user to compare before authorizing this device — the control plane only carried
    /// the key, so a substituted one shows up as two screens that disagree.
    private var fingerprintCard: some View {
        VStack(spacing: 8) {
            Text("This device's fingerprint")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            Text(model.deviceIdentity.fingerprint)
                .font(.mono(17, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text("Approve the dock on the host only if it shows this exact fingerprint.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            if !model.deviceIdentity.secureEnclaveBacked {
                Label("Software key — this device has no Secure Enclave (Simulator).",
                      systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.border))
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

    /// The manual api field's value, only when it passes the pair policy (https / loopback http).
    private var enteredApiUrl: URL? {
        guard let url = URL(string: apiText.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return PairPolicy.allowsApiUrl(url) ? url : nil
    }

    /// Decide whether we can proceed now or must ask for the api url first.
    private func begin(with parsed: PairLink) {
        if let api = parsed.apiUrl ?? model.apiUrl {
            confirmOrRedeem(parsed, apiUrl: api)
        } else {
            step = .needApi(parsed)
        }
    }

    /// The M24 gate. Redeem straight away only for an in-app capture against the known control
    /// plane with nothing trust-bearing changing; a deep link (unsolicited — `link != nil`), a new
    /// api origin, or a host-key re-pin stops at a confirm card first.
    private func confirmOrRedeem(_ parsed: PairLink, apiUrl: URL) {
        guard PairPolicy.allowsApiUrl(apiUrl) else {
            step = .failed("This link points at an insecure control plane — https is required (http only for localhost).")
            return
        }
        let warnings = PairPolicy.warnings(
            link: parsed, apiUrl: apiUrl, storedApiUrl: model.apiUrl, hosts: model.hosts
        )
        if link != nil || !warnings.isEmpty {
            step = .confirm(parsed, apiUrl, warnings)
        } else {
            redeem(parsed, apiUrl: apiUrl)
        }
    }

    private func redeem(_ parsed: PairLink, apiUrl: URL, allowRepin: Bool = false) {
        step = .redeeming
        Task {
            do {
                try await model.redeem(
                    link: parsed, apiUrl: apiUrl, deviceName: UIDevice.current.name, allowRepin: allowRepin
                )
                Haptics.success()
                step = .success(PairedHost.defaultName(for: parsed.hostId))
            } catch let refusal as PairRefusal {
                Haptics.warning()
                step = .failed(Self.message(for: refusal))
            } catch let error as APIError {
                Haptics.warning()
                step = .failed(Self.message(for: error))
            } catch let error as URLError {
                Haptics.warning()
                step = .failed(Self.message(for: error, api: apiUrl))
            } catch {
                Haptics.warning()
                step = .failed("Docking failed unexpectedly — try again, or mint a fresh link with `pherry dock`.")
            }
        }
    }

    private static func message(for refusal: PairRefusal) -> String {
        switch refusal {
        case .insecureApiUrl:
            "This link points at an insecure control plane — https is required (http only for localhost)."
        case .hostMismatch:
            "The control plane answered for a different host than this link names. Refusing to dock."
        case .repinRefused:
            "This link would replace a docked host's pinned key. Un-dock the host first if you meant to."
        }
    }

    /// The control plane answered, and said no. Its redeem refusal is deliberately one
    /// undifferentiated code (enumeration resistance), so the copy hedges between expired and
    /// already-used; a 5xx is its own honest story rather than the link's fault.
    private static func message(for error: APIError) -> String {
        error.status >= 500
            ? "The control plane hit a problem (\(error.status)) — try again in a moment."
            : "The control plane refused this link — it may be expired or already used. Mint a fresh one with `pherry dock`."
    }

    /// The network never delivered an answer — say so instead of blaming the link. (The 2026-07
    /// device pass hit exactly this: a TLS trust failure surfaced as "the link may be expired".)
    private static func message(for error: URLError, api: URL) -> String {
        switch error.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .secureConnectionFailed:
            "This device doesn't trust \(PairPolicy.origin(of: api))'s TLS certificate. For a dev control plane, install the mkcert root CA and fully trust it in Settings."
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            "No network — check this device's connection and try again."
        case .cannotFindHost, .dnsLookupFailed:
            "Couldn't find \(PairPolicy.origin(of: api)) — check the control-plane address."
        case .cannotConnectToHost, .timedOut:
            "Couldn't reach \(PairPolicy.origin(of: api)) — is the control plane up and reachable from this network?"
        default:
            "A network error stopped the dock — check the connection to \(PairPolicy.origin(of: api)) and try again."
        }
    }

    private func finish() {
        model.pendingPair = nil
        dismiss()
    }
}
