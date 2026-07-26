import SwiftUI
import UIKit

/// The quiet utility tab — the device's identity, its push standing, the docked hosts, and the way
/// out. WHY it exists beyond vanity: push can silently fail (a denied prompt, a network blip at
/// launch), and the only honest fix is to show its status and offer a manual re-register; likewise
/// unpairing a host is destructive and deserves a deliberate confirm. Everything here is management,
/// so it reads as a calm form, not a dashboard.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    @State private var renamingHost: PairedHost?
    @State private var renameText = ""
    @State private var unpairing: PairedHost?
    @State private var confirmSignOut = false
    @State private var rotationResult: RotationResult?
    @State private var rotationFailure: String?

    /// A completed S4 key rotation — the new fingerprint the result sheet surfaces.
    private struct RotationResult: Identifiable {
        let fingerprint: String
        var id: String { fingerprint }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                Form {
                    deviceSection
                    identitySection
                    hostsSection
                    aboutSection
                    if model.isPaired { signOutSection }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .alert("Rename host", isPresented: renameBinding) {
                TextField("Name", text: $renameText)
                Button("Save") {
                    if let host = renamingHost { model.rename(hostId: host.id, to: renameText) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                "Unpair \(unpairing?.name ?? "this host")?",
                isPresented: unpairBinding,
                titleVisibility: .visible
            ) {
                Button("Unpair", role: .destructive) {
                    if let host = unpairing {
                        model.unpair(hostId: host.id)
                        Haptics.warning()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("It stays paired on the host — this only forgets it on this phone.")
            }
            .alert("Forget this device?", isPresented: $confirmSignOut) {
                Button("Sign out", role: .destructive) {
                    model.signOut()
                    Haptics.warning()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Clears the device credential, hosts, and push registration on this phone.")
            }
            // S4: flipping presence gating is a key rotation — an enclave key's access control
            // is fixed at creation. Nothing rotates unless this dialog is confirmed.
            .confirmationDialog(
                "Replace this device's key?",
                isPresented: rotationBinding,
                titleVisibility: .visible
            ) {
                Button("Replace key", role: .destructive) { confirmRotation() }
                Button("Cancel", role: .cancel) { model.cancelIdentityRotation() }
            } message: {
                Text(rotationWarning)
            }
            .alert(
                "Couldn't replace the key",
                isPresented: rotationFailureBinding,
                actions: { Button("OK", role: .cancel) {} },
                message: { Text(rotationFailure ?? "") }
            )
            .sheet(item: $rotationResult) { result in
                rotationResultSheet(result)
            }
        }
    }

    // MARK: - Sections

    private var deviceSection: some View {
        Section {
            LabeledContent("Device", value: UIDevice.current.name)
            if let apiUrl = model.apiUrl {
                LabeledContent("Control plane") {
                    Text(apiUrl.absoluteString)
                        .font(.mono(12))
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            HStack {
                Image(systemName: pushIcon)
                    .foregroundStyle(pushColor)
                Text(model.push.status.label)
                    .foregroundStyle(Theme.text)
                Spacer()
                Button("Re-register") { model.registerPush() }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
        } header: {
            Text("This device")
        }
        .listRowBackground(Theme.surface)
    }

    /// The S3/S4 device identity: the fingerprint hosts enroll, and the presence-gating
    /// toggle. Flipping the toggle only *requests* a rotation — the confirm dialog is the gate.
    private var identitySection: some View {
        Section {
            LabeledContent("Fingerprint") {
                Text(model.deviceIdentity.fingerprint)
                    .font(.mono(13, weight: .semibold))
                    .foregroundStyle(Theme.text)
            }
            Toggle("Require Face ID to steer", isOn: presenceBinding)
                .tint(Theme.accent)
                .disabled(!model.deviceIdentity.presenceGatingAvailable)
        } header: {
            Text("Device identity")
        } footer: {
            Text(identityFooter)
                .foregroundStyle(Theme.muted)
        }
        .listRowBackground(Theme.surface)
    }

    private var hostsSection: some View {
        Section {
            if model.hosts.isEmpty {
                Text("No hosts docked yet.")
                    .foregroundStyle(Theme.muted)
            } else {
                ForEach(model.hosts) { host in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(host.name).foregroundStyle(Theme.text)
                            Text("key \(host.keyPrefix)…")
                                .font(.mono(11))
                                .foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        Menu {
                            Button {
                                renameText = host.name
                                renamingHost = host
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            Button(role: .destructive) {
                                unpairing = host
                            } label: {
                                Label("Unpair", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(Theme.muted)
                        }
                    }
                }
            }
        } header: {
            Text("Docked hosts")
        }
        .listRowBackground(Theme.surface)
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("Version", value: appVersion)
            Link(destination: URL(string: "https://pherry.dev")!) {
                Label("About Pherry", systemImage: "info.circle")
            }
        } header: {
            Text("About")
        } footer: {
            Text("Steer your coding agents from your phone — end-to-end encrypted, relay-blind.")
                .foregroundStyle(Theme.muted)
        }
        .listRowBackground(Theme.surface)
    }

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) { confirmSignOut = true } label: {
                Text("Sign out of this device")
            }
        }
        .listRowBackground(Theme.surface)
    }

    /// The post-rotation card — the same fingerprint presentation the pairing success step
    /// uses, because this is the number every host now has to re-enroll.
    private func rotationResultSheet(_ result: RotationResult) -> some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "key.horizontal.fill")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(Theme.accent)
                Text("New device fingerprint")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text)
                VStack(spacing: 8) {
                    Text(result.fingerprint)
                        .font(.mono(17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text("Every host still knows the old key, so each will refuse this phone until you re-pair it with `pherry dock` — approve the dock only if the host shows this exact fingerprint.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(12)
                .frame(maxWidth: .infinity)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.border))
                Button("Done") { rotationResult = nil }
                    .buttonStyle(PherryButtonStyle())
            }
            .padding(24)
        }
        .presentationDetents([.medium])
    }

    // MARK: - Rotation plumbing (S4)

    /// The toggle reflects the *current key's* real mode; a tap only records the request —
    /// the confirmation dialog is the sole path to an actual rotation.
    private var presenceBinding: Binding<Bool> {
        Binding(
            get: { model.deviceIdentity.presenceGated },
            set: { model.requestIdentityRotation(presenceGated: $0) }
        )
    }

    private var rotationBinding: Binding<Bool> {
        Binding(
            get: { model.pendingIdentityRotation != nil },
            set: { if !$0 { model.cancelIdentityRotation() } }
        )
    }

    private var rotationFailureBinding: Binding<Bool> {
        Binding(
            get: { rotationFailure != nil },
            set: { if !$0 { rotationFailure = nil } }
        )
    }

    private var rotationWarning: String {
        let mode = model.pendingIdentityRotation == true
            ? "Face ID will be required every time this phone steers a host."
            : "Steering will stop asking for Face ID."
        return mode + " This replaces the device key: the fingerprint changes, every host must re-pair with `pherry dock`, and hosts will refuse this phone until then."
    }

    private var identityFooter: String {
        if !model.deviceIdentity.secureEnclaveBacked {
            return "This device has no Secure Enclave, so the identity is a software key and signing can't require Face ID."
        }
        if !model.deviceIdentity.presenceGatingAvailable {
            return "The Simulator can't require Face ID — presence-gated keys need a real device."
        }
        return "Hosts enroll this fingerprint when you pair. Flipping the toggle replaces the key — the fingerprint changes and every host must re-pair with `pherry dock`."
    }

    private func confirmRotation() {
        do {
            let identity = try model.confirmIdentityRotation()
            Haptics.warning()
            rotationResult = RotationResult(fingerprint: identity.fingerprint)
        } catch {
            Haptics.warning()
            rotationFailure = error.localizedDescription
        }
    }

    // MARK: - Derived

    private var appVersion: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    private var pushIcon: String {
        switch model.push.status {
        case .registered: "bell.badge.fill"
        case .denied, .failed: "bell.slash"
        default: "bell"
        }
    }

    private var pushColor: Color {
        switch model.push.status {
        case .registered: Theme.live
        case .denied, .failed: Theme.danger
        default: Theme.muted
        }
    }

    private var renameBinding: Binding<Bool> {
        Binding(get: { renamingHost != nil }, set: { if !$0 { renamingHost = nil } })
    }

    private var unpairBinding: Binding<Bool> {
        Binding(get: { unpairing != nil }, set: { if !$0 { unpairing = nil } })
    }
}
