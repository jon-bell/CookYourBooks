import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

/// Turns the hardware volume buttons into a camera shutter while the in-app
/// scanner is open. The web layer (`import/volumeButton.ts`) calls
/// `startListening()` when the camera mounts and `stopListening()` on unmount;
/// each volume press emits a `volumePressed` event carrying the press
/// direction (`{ direction: "up" | "down" }`) so the shutter can pick a
/// variant (up = capture + chain to the previous page, down = plain capture).
///
/// Implementation: KVO on `AVAudioSession.outputVolume`. We use the `.ambient`
/// category with `.mixWithOthers` so activating the session does NOT interrupt
/// any music the user is playing while scanning. After each press we snap the
/// system volume back to a mid baseline (via a hidden `MPVolumeView` slider) so
/// a press always changes the level — otherwise a press at max/min volume would
/// produce no KVO callback and be missed.
///
/// Sleep survival: locking the phone (or any audio interruption) deactivates
/// our audio session, after which volume presses stop producing KVO callbacks
/// even though the observer is still registered. While observing we watch
/// `UIApplication.didBecomeActiveNotification` and
/// `AVAudioSession.interruptionNotification` (`.ended` only) and re-activate
/// the session + re-baseline — never re-adding the KVO observer, which
/// survives the sleep.
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
    private var notificationTokens: [NSObjectProtocol] = []

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
        activateSession()

        // A hidden, off-screen MPVolumeView is the only supported way to set the
        // system volume programmatically. It must be in the view hierarchy.
        if volumeView == nil, let root = bridge?.viewController?.view {
            let view = MPVolumeView(frame: CGRect(x: -4000, y: -4000, width: 1, height: 1))
            root.addSubview(view)
            volumeView = view
        }

        rebaseline()
        session.addObserver(self, forKeyPath: "outputVolume", options: [.new], context: nil)
        observing = true

        // Resume handlers. `observing` guards them so a late-arriving
        // notification after end() is a no-op; the KVO observer itself is
        // never re-added — only session activation dies on lock/interruption.
        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.resume()
        })
        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            // Only the end of an interruption is actionable; reacting to
            // `.began` would fight the interrupting audio for the session.
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            self?.resume()
        })
    }

    private func end() {
        guard observing else { return }
        session.removeObserver(self, forKeyPath: "outputVolume")
        observing = false
        for token in notificationTokens {
            NotificationCenter.default.removeObserver(token)
        }
        notificationTokens = []
        volumeView?.removeFromSuperview()
        volumeView = nil
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func activateSession() {
        do {
            // .ambient + mixWithOthers: observe volume without stopping the
            // user's music or ducking other audio.
            try session.setCategory(.ambient, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            // Observation can still work if a session is already active.
        }
    }

    /// Re-read the volume and, if it's pinned near an edge, move it to the
    /// middle so a press in either direction produces a KVO callback. Arms
    /// `ignoreNextChange` only alongside an actual write (a stale flag with no
    /// echo coming would swallow the next real press). The write is dispatched
    /// async, so even during begin() the echo lands after the KVO observer is
    /// registered — without the flag it would fire a phantom shutter.
    private func rebaseline() {
        baseline = session.outputVolume
        if baseline <= 0.05 || baseline >= 0.95 {
            baseline = 0.5
            ignoreNextChange = true
            setSystemVolume(baseline)
        }
    }

    /// Called on app-resume / interruption-end: the KVO observer is still
    /// registered but the session was deactivated, so presses no longer
    /// produce callbacks until we re-activate.
    private func resume() {
        guard observing else { return }
        activateSession()
        rebaseline()
    }

    public override func observeValue(
        forKeyPath keyPath: String?,
        of object: Any?,
        change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        guard observing, keyPath == "outputVolume" else { return }
        let newValue = (change?[.newKey] as? NSNumber)?.floatValue ?? session.outputVolume
        if ignoreNextChange {
            ignoreNextChange = false
            // Our own snap-back echo lands at the baseline. A value anywhere
            // else means a real press raced the reset — fall through and emit.
            if abs(newValue - baseline) < 0.001 { return }
        }
        // Equality can't reach here: the epsilon check above consumed the
        // at-baseline case, and an unchanged level produces no KVO callback.
        let direction = newValue > baseline ? "up" : "down"
        notifyListeners("volumePressed", data: ["direction": direction])
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
        for token in notificationTokens {
            NotificationCenter.default.removeObserver(token)
        }
    }
}
