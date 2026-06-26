import UIKit
import Capacitor

/// Custom bridge VC so we can flip WKWebView knobs Capacitor doesn't expose
/// via config. Wired in Main.storyboard (customClass) — keep that in sync.
class ViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // Register app-local plugins. CybFile reads a PDF/image the Share
        // Extension stashed in the app group container so the web layer can
        // ingest it. App-local plugins aren't in capacitor.config.json's
        // auto-register list, so register the instance explicitly here.
        bridge?.registerPluginInstance(CybFilePlugin())
        // Edge-swipe back/forward navigates the WKWebView back-forward list,
        // which includes SPA pushState entries — React Router receives the
        // resulting popstate (and the web layer's scroll restoration treats
        // it as a POP). The gesture is simply inert at the history root.
        webView?.allowsBackForwardNavigationGestures = true
        // Status-bar tap → scroll to top. Works because the app scrolls the
        // window (one primary scroll view) and scrollsToTop is enabled on it.
        webView?.scrollView.scrollsToTop = true
    }
}
