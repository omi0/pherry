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

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                Form {
                    deviceSection
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
