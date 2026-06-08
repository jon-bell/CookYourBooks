//
//  ShareViewController.swift
//  mindlib
//
//  Created by Carsten Klaffke on 05.07.20.
//

import MobileCoreServices
import Social
import UIKit

class ShareItem {

    public var title: String?
    public var type: String?
    public var url: String?
}

class ShareViewController: UIViewController {

    private var shareItems: [ShareItem] = []
    // completeRequest tears the extension down, so it must run exactly once and
    // only AFTER we've dispatched the deep link — never on viewDidAppear.
    private var didComplete = false

    // IMPORTANT: do NOT complete the request in viewDidAppear. The payload is
    // loaded and the `cookyourbooks://` deep link is opened asynchronously (the
    // Task in viewDidLoad). Completing on appear raced that work and tore the
    // extension down before `openURL` dispatched: fast in-memory `public.text`
    // shares (YouTube) usually won the race, but slower `public.url` loads
    // (NYT Cooking, most websites) lost it, so the app "didn't even open." We
    // now complete only after the open is dispatched (plus a safety timeout).

    override public func viewDidLoad() {
        super.viewDidLoad()
        shareItems.removeAll()

        guard
            let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
            let attachments = extensionItem.attachments
        else {
            NSLog("[CYB-Share] viewDidLoad: no extension item / attachments")
            complete()
            return
        }

        // Safety net: if a loadItem ever hangs, don't leave the share sheet
        // wedged on a blank screen forever. complete() is idempotent.
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
            self?.complete()
        }

        Task {
            await withTaskGroup(of: ShareItem?.self) { group in
                for (index, attachment) in attachments.enumerated() {
                    if attachment.hasItemConformingToTypeIdentifier(kUTTypeURL as String) {
                        group.addTask { await self.handleTypeUrl(attachment) }
                    } else if attachment.hasItemConformingToTypeIdentifier(kUTTypeText as String) {
                        group.addTask { await self.handleTypeText(attachment) }
                    } else if attachment.hasItemConformingToTypeIdentifier(kUTTypeMovie as String) {
                        group.addTask { await self.handleTypeMovie(attachment) }
                    } else if attachment.hasItemConformingToTypeIdentifier(kUTTypeImage as String) {
                        group.addTask { await self.handleTypeImage(attachment, index) }
                    }
                }
                for await item in group {
                    if let item = item { self.shareItems.append(item) }
                }
            }
            self.sendData()
        }
    }

    private func complete() {
        if didComplete { return }
        didComplete = true
        self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    private func sendData() {
        NSLog("[CYB-Share] sendData: \(shareItems.count) item(s)")
        for (i, item) in shareItems.enumerated() {
            NSLog("[CYB-Share]   item[\(i)] title=\(item.title ?? "nil") type=\(item.type ?? "nil") url=\(item.url ?? "nil")")
        }
        // Percent-encode each value ourselves with the encodeURIComponent
        // "unreserved" set (escapes : / ? & = etc.), then assign via
        // `percentEncodedQueryItems` so URLComponents does NOT re-encode.
        // The old code pre-encoded with .urlHostAllowed AND used
        // `queryItems`, which re-escaped the `%` we wrote (%3A -> %253A)
        // -> double-encoded deep link the web couldn't parse (Sentry
        // CYB-CAPACITOR-D). Pre-encoding is still required because
        // `queryItems` won't escape `&`/`=` inside a value and would
        // otherwise split a shared URL's own query into stray params.
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        func enc(_ s: String?) -> String {
            (s ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        }
        let queryItems = shareItems.flatMap { item -> [URLQueryItem] in
            [
                URLQueryItem(name: "title", value: enc(item.title)),
                URLQueryItem(name: "description", value: ""),
                URLQueryItem(name: "type", value: enc(item.type)),
                URLQueryItem(name: "url", value: enc(item.url)),
            ]
        }
        guard var urlComps = URLComponents(string: "cookyourbooks://") else {
            complete()
            return
        }
        urlComps.percentEncodedQueryItems = queryItems
        guard let finalUrl = urlComps.url else {
            NSLog("[CYB-Share] sendData: failed to build final URL")
            complete()
            return
        }
        NSLog("[CYB-Share] sendData: opening \(finalUrl.absoluteString)")
        openURL(finalUrl) { [weak self] in
            // Tear the extension down only AFTER the open has been dispatched.
            self?.complete()
        }
    }

    fileprivate func createSharedFileUrl(_ url: URL?) -> String {
        guard let sourceUrl = url else {
            return ""
        }

        let fileManager = FileManager.default
        guard let containerUrl = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: "group.app.cookyourbooks"
        ) else {
            print("Failed to resolve app group container URL")
            return ""
        }

        let sanitizedName = sourceUrl.lastPathComponent.replacingOccurrences(of: "/", with: "_")
        let destinationUrl = containerUrl.appendingPathComponent("\(UUID().uuidString)_\(sanitizedName)")

        do {
            try fileManager.copyItem(at: sourceUrl, to: destinationUrl)
            return destinationUrl.absoluteString
        } catch {
            print("Failed to copy shared file: \(error.localizedDescription)")
            return ""
        }
    }

    func saveScreenshot(_ image: UIImage, _ index: Int) -> String {
        let fileManager = FileManager.default

        let copyFileUrl =
        fileManager.containerURL(forSecurityApplicationGroupIdentifier: "group.app.cookyourbooks")!
            .absoluteString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!
        + "/screenshot_\(index).png"
        do {
            try image.pngData()?.write(to: URL(string: copyFileUrl)!)
            return copyFileUrl
        } catch {
            print(error.localizedDescription)
            return ""
        }
    }

    // Handlers return nil (rather than throwing / force-unwrapping) on any
    // unexpected payload so one odd attachment can never crash the extension
    // before the hand-off — that, too, looks like "the app didn't open."
    fileprivate func handleTypeUrl(_ attachment: NSItemProvider) async -> ShareItem? {
        guard let results = try? await attachment.loadItem(
            forTypeIdentifier: kUTTypeURL as String, options: nil
        ) else {
            NSLog("[CYB-Share] handleTypeUrl: loadItem failed")
            return nil
        }
        let shareItem = ShareItem()
        // public.url usually arrives as URL/NSURL, but some hosts hand it over
        // as a String or UTF-8 Data — accept all three rather than crashing.
        if let url = results as? URL {
            if url.isFileURL {
                shareItem.title = url.lastPathComponent
                shareItem.type = "application/" + url.pathExtension.lowercased()
                shareItem.url = createSharedFileUrl(url)
            } else {
                shareItem.title = url.absoluteString
                shareItem.url = url.absoluteString
                shareItem.type = "text/plain"
            }
            return shareItem
        }
        if let str = results as? String {
            shareItem.title = str
            shareItem.url = str
            shareItem.type = "text/plain"
            return shareItem
        }
        if let data = results as? Data, let str = String(data: data, encoding: .utf8) {
            shareItem.title = str
            shareItem.url = str
            shareItem.type = "text/plain"
            return shareItem
        }
        NSLog("[CYB-Share] handleTypeUrl: unexpected item type \(type(of: results))")
        return nil
    }

    fileprivate func handleTypeText(_ attachment: NSItemProvider) async -> ShareItem? {
        guard
            let results = try? await attachment.loadItem(
                forTypeIdentifier: kUTTypeText as String, options: nil
            ),
            let text = results as? String
        else {
            NSLog("[CYB-Share] handleTypeText: loadItem failed / not a string")
            return nil
        }
        let shareItem = ShareItem()
        shareItem.title = text
        shareItem.type = "text/plain"
        return shareItem
    }

    fileprivate func handleTypeMovie(_ attachment: NSItemProvider) async -> ShareItem? {
        guard
            let results = try? await attachment.loadItem(
                forTypeIdentifier: kUTTypeMovie as String, options: nil
            ),
            let url = results as? URL
        else {
            NSLog("[CYB-Share] handleTypeMovie: loadItem failed / not a URL")
            return nil
        }
        let shareItem = ShareItem()
        shareItem.title = url.lastPathComponent
        shareItem.type = "video/" + url.pathExtension.lowercased()
        shareItem.url = createSharedFileUrl(url)
        return shareItem
    }

    fileprivate func handleTypeImage(_ attachment: NSItemProvider, _ index: Int) async -> ShareItem? {
        guard let data = try? await attachment.loadItem(
            forTypeIdentifier: kUTTypeImage as String, options: nil
        ) else {
            NSLog("[CYB-Share] handleTypeImage: loadItem failed")
            return nil
        }
        let shareItem = ShareItem()
        switch data {
        case let image as UIImage:
            shareItem.title = "screenshot_\(index)"
            shareItem.type = "image/png"
            shareItem.url = self.saveScreenshot(image, index)
        case let url as URL:
            shareItem.title = url.lastPathComponent
            shareItem.type = "image/" + url.pathExtension.lowercased()
            shareItem.url = self.createSharedFileUrl(url)
        default:
            NSLog("[CYB-Share] handleTypeImage: unexpected image data \(type(of: data))")
            return nil
        }
        return shareItem
    }

    @objc func openURL(_ url: URL, completion: @escaping () -> Void) {
        var responder: UIResponder? = self
        while responder != nil {
            if let application = responder as? UIApplication {
                NSLog("[CYB-Share] openURL: dispatching via UIApplication.open")
                application.open(url, options: [:], completionHandler: { ok in
                    NSLog("[CYB-Share] openURL: completion ok=\(ok)")
                    completion()
                })
                return
            }
            responder = responder?.next
        }
        NSLog("[CYB-Share] openURL: no UIApplication responder found, URL not delivered")
        completion()
    }

}
