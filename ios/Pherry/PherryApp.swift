import SwiftUI
import UIKit
import UserNotifications

/// The app entry point — one window, the ``AppModel`` in the environment, and the two ways the
/// outside world reaches in: a `pherry://pair` deep link (`onOpenURL`) and notifications (the app
/// delegate). Push/ring wiring lives in the delegate because APNs device tokens and notification
/// taps are UIKit-delegate events with no SwiftUI equivalent.
@main
struct PherryApp: App {
    @UIApplicationDelegateAdaptor(PherryAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.accent)
                .task {
                    appDelegate.connect(to: model)
                    model.bootstrap()
                    // The door prompt on a cold launch — `.onChange` below covers every
                    // later foreground return; the session's own guard makes the overlap
                    // harmless (one evaluation, ever, per foreground session).
                    await model.presenceDidEnterForeground()
                }
                .onOpenURL { url in
                    model.handle(url: url)
                }
                // Foreground-session presence (S4 refinement): Face ID at the door on every
                // return to the foreground, an immediate re-lock the moment the app leaves.
                // `.inactive` is deliberately ignored — it fires for transient overlays
                // (notification shade, the Face ID sheet itself) where re-locking would flap.
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task { await model.presenceDidEnterForeground() }
                    case .background:
                        model.presenceDidLeaveForeground()
                    default:
                        break
                    }
                }
        }
    }
}

/// The UIKit delegate: it carries APNs alert-token registration and notification taps back to the
/// ``AppModel``. Marked `@MainActor` because every callback it uses is delivered on the main thread
/// and it touches main-actor state.
@MainActor
final class PherryAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private weak var model: AppModel?
    /// An APNs token that arrived before the model was connected (buffered, then handed over).
    private var pendingApnsToken: Data?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Bind the live model once the scene is up, flushing any early APNs token.
    func connect(to model: AppModel) {
        self.model = model
        if let token = pendingApnsToken {
            model.push.receiveAPNsToken(token)
            pendingApnsToken = nil
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        if let model {
            model.push.receiveAPNsToken(deviceToken)
        } else {
            pendingApnsToken = deviceToken
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        model?.push.apnsRegistrationFailed()
    }

    // MARK: - UNUserNotificationCenterDelegate

    // These requirements are non-isolated (the protocol isn't `@MainActor`) and carry non-Sendable
    // arguments, so the implementations stay `nonisolated`: they read the userInfo locally, reduce
    // it to a Sendable route, and hop to the main actor with just that.

    /// Show alert pushes while foregrounded so the inbox badge and banner stay honest.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    /// A tapped alert push deep-links into the inbox (and through to the session).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard case let .event(id)? =
            DeepLinkRouter.route(pushUserInfo: response.notification.request.content.userInfo)
        else { return }
        await routeToEvent(id)
    }

    /// Deliver a deep-linked event id to the model on the main actor.
    private func routeToEvent(_ id: String) {
        model?.openEvent(id: id)
    }
}
