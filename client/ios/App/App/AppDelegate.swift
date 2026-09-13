import UIKit
import WebKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Suppress the over-scroll white band from the first frame, not just from the
        // first foreground — see disableWebViewBounce below.
        disableWebViewBounceWithRetry()
        return true
    }

    // Kill the white band the WKWebView's own scroll view shows on over-scroll
    // (13 Sep 2026, hardened). TWO native causes, both outside anything CSS can reach —
    // the region belongs to the webview's UIScrollView, not to the document, so
    // overscroll-behavior on <body> and a themed <html> background never touch it:
    //
    //   1. THE RUBBER-BAND BOUNCE. A hard downward drag rubber-bands the whole webview
    //      and drags a strip into view above the header, painted by the webview's native
    //      backing — the static white from capacitor.config.json's backgroundColor. In
    //      dark mode that is a white flash over a dark screen. `bounces = false` removes
    //      the bounce, so no strip is ever revealed and the backing colour never shows.
    //
    //   2. THE CONTENT-INSET ADJUSTMENT. iOS auto-insets a full-screen scroll view for
    //      the safe area; under overlaysWebView:true this app already pays the inset
    //      itself in CSS (the header's env(safe-area-inset-top) padding), so the native
    //      adjustment is a SECOND inset — a persistent white band at the top, present
    //      without any drag at all. `contentInsetAdjustmentBehavior = .never` hands the
    //      inset wholly to CSS. (capacitor.config.json's ios.contentInset is also set to
    //      "never" for the same reason; this is the belt to that suspenders, because the
    //      config value has been observed not to stick on every Capacitor version.)
    //
    // Neither costs anything the app uses: pull-to-refresh is a hand-built gesture on the
    // INNER scrollport (PhoneShell.jsx), which scrolls and refreshes exactly as before —
    // only the outer webview chrome stops moving, which is how a native app behaves.
    //
    // In the app delegate rather than a CAPBridgeViewController subclass, on purpose: a
    // subclass must also be wired into the Xcode project and Main.storyboard, and a
    // hand-edited project.pbxproj silently breaks the next `npx cap sync`. Applied on
    // didFinishLaunching (with a short retry, because the bridge's webview is created
    // slightly after launch and the first read can miss it) AND re-applied on every
    // didBecomeActive — idempotent, so re-applying a flag already set is free.
    private func disableWebViewBounce() {
        guard let bridgeVC = window?.rootViewController as? CAPBridgeViewController,
              let scrollView = bridgeVC.webView?.scrollView else { return }
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.contentInsetAdjustmentBehavior = .never
    }

    // The webview is built a beat after launch; the first read can find no scrollView.
    // Retry a few times over the first second so a cold launch is covered without waiting
    // for the user to background and foreground the app once.
    private func disableWebViewBounceWithRetry(_ attempts: Int = 8) {
        disableWebViewBounce()
        guard attempts > 0,
              (window?.rootViewController as? CAPBridgeViewController)?.webView?.scrollView == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            self?.disableWebViewBounceWithRetry(attempts - 1)
        }
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
