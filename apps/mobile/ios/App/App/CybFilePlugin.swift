import Foundation
import Capacitor

/// Reads a file the Share Extension copied into the app group container
/// (`group.app.cookyourbooks`) and hands the bytes to the web layer as base64.
/// The share extension can't pass megabytes of PDF through the
/// `cookyourbooks://` deep link, so it passes only the `file://` path; the web
/// `import/sharedFile.ts` calls this plugin to pull the bytes on demand.
///
/// Registered manually from `ViewController.capacitorDidLoad()` (app-local
/// plugins aren't in `capacitor.config.json`'s auto-register list). Swift-only
/// via `CAPBridgedPlugin` — no Objective-C `.m` / bridging header needed.
@objc(CybFilePlugin)
public class CybFilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CybFilePlugin"
    public let jsName = "CybFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readSharedFile", returnType: CAPPluginReturnPromise)
    ]

    @objc func readSharedFile(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("Missing file url")
            return
        }
        // The share extension hands over a `file://…` absolute string.
        let fileURL = URL(string: urlString) ?? URL(fileURLWithPath: urlString)
        do {
            let data = try Data(contentsOf: fileURL)
            let base64 = data.base64EncodedString()
            let name = fileURL.lastPathComponent
            let mime = CybFilePlugin.mimeFor(fileURL.pathExtension.lowercased())
            // Best-effort cleanup so shared files don't accumulate in the group.
            try? FileManager.default.removeItem(at: fileURL)
            call.resolve([
                "base64": base64,
                "mimeType": mime,
                "name": name
            ])
        } catch {
            call.reject("Could not read shared file: \(error.localizedDescription)")
        }
    }

    private static func mimeFor(_ ext: String) -> String {
        switch ext {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "heic": return "image/heic"
        case "heif": return "image/heif"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        default: return "application/octet-stream"
        }
    }
}
