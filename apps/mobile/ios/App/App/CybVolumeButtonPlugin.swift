import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

/// Turns the hardware volume buttons into a camera shutter while the in-app
/// scanner is open. The web layer (`import/volumeButton.ts`) calls
/// `startListening()` when the camera mounts and `stopListening()` on unmount;
/// each volume press emits a `volumePressed` event that fires the shutter.
///
/// Implementation: KVO on `AVAudioSession.outputVolume`. We use the `.ambient`
/// category with `.mixWithOthers` so activating the session does NOT interrupt
/// any music the user is playing while scanning. After each press we snap the
/// system volume back to a mid baseline (via a hidden `MPVolumeView` slider) so
/// a press always changes the level — otherwise a press at max/min volume would
/// produce no KVO callback and be missed.
///
/// Registered manually from `ViewController.capacitorDidLoad()` (Swift-only via
/// `CAPBridgedPlugin`, matching `CybFilePlugin`). Best-effort: any failure is
/// swallowed, and the web bridge is feature-detected so builds without this
/// plugin just no-op.
@objc(CybVolumeButtonPlugin)
public class CybVolumeButtonPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CybVolumeButtonPlugin"
    public let jsName = "CybVolumeButton"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopListening", returnType: CAPPluginReturnPromise)
    ]

    private let session = AVAudioSession.sharedInstance()
    private var observing = false
    private var baseline: Float = 0.5
    // The next KVO callback is our own volume reset, not a user press — skip it.
    private var ignoreNextChange = false
    private var volumeView: MPVolumeView?

    @objc func startListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.begin()
            call.resolve()
        }
    }

    @objc func stopListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.end()
            call.resolve()
        }
    }

    private func begin() {
        guard !observing else { return }
        do {
            // .ambient + mixWithOthers: observe volume without stopping the
            // user's music or ducking other audio.
            try session.setCategory(.ambient, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            // Observation can still work if a session is already active.
        }

        // A hidden, off-screen MPVolumeView is the only supported way to set the
        // system volume programmatically. It must be in the view hierarchy.
        if volumeView == nil, let root = bridge?.viewController?.view {
            let view = MPVolumeView(frame: CGRect(x: -4000, y: -4000, width: 1, height: 1))
            root.addSubview(view)
            volumeView = view
        }

        baseline = session.outputVolume
        // Keep headroom in both directions so any press moves the level.
        if baseline <= 0.05 || baseline >= 0.95 {
            baseline = 0.5
            setSystemVolume(baseline)
        }

        session.addObserver(self, forKeyPath: "outputVolume", options: [.new], context: nil)
        observing = true
    }

    private func end() {
        guard observing else { return }
        session.removeObserver(self, forKeyPath: "outputVolume")
        observing = false
        volumeView?.removeFromSuperview()
        volumeView = nil
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }

    public override func observeValue(
        forKeyPath keyPath: String?,
        of object: Any?,
        change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        guard observing, keyPath == "outputVolume" else { return }
        if ignoreNextChange {
            ignoreNextChange = false
            return
        }
        notifyListeners("volumePressed", data: [:])
        // Snap back to baseline so the next press has headroom to register.
        ignoreNextChange = true
        setSystemVolume(baseline)
    }

    private func setSystemVolume(_ value: Float) {
        DispatchQueue.main.async {
            guard let slider = self.volumeView?.subviews
                .compactMap({ $0 as? UISlider }).first else { return }
            slider.value = value
        }
    }

    deinit {
        if observing {
            session.removeObserver(self, forKeyPath: "outputVolume")
        }
    }
}
