import UIKit
import Capacitor
import SendIntent

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // Backing store the SendIntent plugin reads from when the JS layer
    // calls `checkSendIntentReceived()`. We populate it below in
    // `application(_:open:options:)` whenever the Share Extension wakes
    // us via the cookyourbooks:// URL scheme.
    let shareStore = ShareStore.store

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
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
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // The Share Extension wakes us with cookyourbooks://?title=…&url=…
        // We split into two responsibilities:
        //  1. Hand the URL to Capacitor's proxy so the @capacitor/app
        //     `appUrlOpen` listener still fires (warm-start path used by
        //     shareIntent.ts when the JS layer is already running).
        //  2. Parse the query items into SendIntent.ShareStore so the
        //     cold-start path (`SendIntent.checkSendIntentReceived()`)
        //     returns the shared payload instead of an empty record.
        //
        // Without (2), a cold launch via the share sheet would open the
        // app to a blank library because nothing tells the web bundle a
        // share even happened. Boilerplate is from send-intent's README.
        let proxyHandled = ApplicationDelegateProxy.shared.application(app, open: url, options: options)
        NSLog("[CYB] AppDelegate open url=\(url.absoluteString) proxyHandled=\(proxyHandled)")

        guard let components = NSURLComponents(url: url, resolvingAgainstBaseURL: true),
              let params = components.queryItems else {
            NSLog("[CYB] AppDelegate: no query items, skipping ShareStore population")
            return proxyHandled
        }

        let titles = params.filter { $0.name == "title" }
        let descriptions = params.filter { $0.name == "description" }
        let types = params.filter { $0.name == "type" }
        let urls = params.filter { $0.name == "url" }

        shareStore.shareItems.removeAll()

        if titles.count > 0 {
            for index in 0...titles.count - 1 {
                var shareItem: JSObject = JSObject()
                shareItem["title"] = titles[index].value ?? ""
                shareItem["description"] = index < descriptions.count ? (descriptions[index].value ?? "") : ""
                shareItem["type"] = index < types.count ? (types[index].value ?? "") : ""
                shareItem["url"] = index < urls.count ? (urls[index].value ?? "") : ""
                shareStore.shareItems.append(shareItem)
            }
            NSLog("[CYB] AppDelegate: stashed \(shareStore.shareItems.count) share item(s) in ShareStore")
        } else {
            NSLog("[CYB] AppDelegate: query items present but no title — nothing stashed")
        }

        shareStore.processed = false
        // Warm-start signal — the SendIntent plugin posts a JS
        // `sendIntentReceived` window event so listeners that subscribed
        // after cold-start can still pick the payload up.
        NotificationCenter.default.post(name: Notification.Name("triggerSendIntent"), object: nil)

        return proxyHandled
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
