import UIKit
import WebKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    // Stop the WKWebView's own rubber-band bounce (13 Sep 2026). A hard downward drag
    // rubber-banded the ENTIRE page — header included — and the strip dragged into
    // view above it is painted by the webview's native backing (the static white from
    // capacitor.config.json's backgroundColor), which no CSS can theme: in dark mode
    // that is a white flash above a dark screen, the exact defect a device screenshot
    // showed. The CSS half of the defence (overscroll-behavior-y: none on <body>,
    // index.css) does not reach this layer — the bounce belongs to the webview's
    // UIScrollView, not to the document.
    //
    // Turning bounces off loses nothing the app relies on: pull-to-refresh here is a
    // hand-built gesture on the app's INNER scrollport (PhoneShell.jsx), which scrolls
    // and refreshes exactly as before — only the outer shell stops moving, which is
    // how a native app's chrome behaves.
    //
    // Done here in the app delegate, rather than in a CAPBridgeViewController
    // subclass, on purpose: a subclass must also be added to the Xcode project file
    // and wired into Main.storyboard, and a hand-edited project.pbxproj is the kind
    // of change that silently breaks the next `npx cap sync`. applicationDidBecomeActive
    // fires after the storyboard's bridge controller has loaded its webview, and
    // re-applying an already-false flag on every foreground is free.
    private func disableWebViewBounce() {
        guard let bridgeVC = window?.rootViewController as? CAPBridgeViewController,
              let scrollView = bridgeVC.webView?.scrollView else { return }
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        disableWebViewBounce()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - Push notifications
    //
    // iOS hands the APNs device token to the app delegate. Without these three
    // methods forwarding it to Capacitor, the "registration" listener in
    // client/src/push.js never fires: registration appears to succeed, no token is
    // ever sent to the server, and the device silently receives nothing.

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
