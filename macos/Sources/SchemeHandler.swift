import Foundation
import WebKit
import CryptoKit

/// Serves `mdstudio://app/index.html` (the bundled single file) and, for relative
/// images, files from the document's folder. Images only, never outside the folder.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let imageTypes: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "svg": "image/svg+xml", "webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp",
        "ico": "image/x-icon", "heic": "image/heic",
    ]
    let folder: () -> URL?

    init(folder: @escaping () -> URL?) { self.folder = folder }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); return }
        let path = url.path
        if path == "/index.html" || path == "/" || path.isEmpty {
            guard let file = Bundle.main.url(forResource: "markdown-studio", withExtension: "html"),
                  let data = try? Data(contentsOf: file) else {
                task.didFailWithError(URLError(.fileDoesNotExist)); return
            }
            guard let csp = Self.policy(forPage: data) else {
                task.didFailWithError(URLError(.cannotParseResponse)); return   // never serve the page unprotected
            }
            respond(task, url, data, "text/html; charset=utf-8", csp: csp)
            return
        }
        guard let base = folder()?.resolvingSymlinksInPath().standardizedFileURL else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let rel = String(path.drop(while: { $0 == "/" }))
        let target = base.appendingPathComponent(rel).resolvingSymlinksInPath().standardizedFileURL
        let ext = target.pathExtension.lowercased()
        guard target.path.hasPrefix(base.path + "/"), let mime = Self.imageTypes[ext],
              let data = try? Data(contentsOf: target) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        respond(task, url, data, mime)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    /// CSP for the page. The one inline <script> (the whole bundle) is allowed by its SHA-256, computed
    /// from the bytes actually being served, so it stays right after every rebuild. No 'unsafe-inline'
    /// for scripts: raw HTML in a document (onerror=..., injected <script>, javascript: links) cannot run.
    /// Styles stay 'unsafe-inline' (one inline <style> plus style attributes from rendered markdown).
    static func policy(forPage page: Data) -> String? {
        guard let html = String(data: page, encoding: .utf8),
              let open = html.range(of: "<script>"),
              let close = html.range(of: "</script>", range: open.upperBound..<html.endIndex) else { return nil }
        let body = Data(html[open.upperBound..<close.lowerBound].utf8)
        let hash = Data(SHA256.hash(data: body)).base64EncodedString()
        return [
            "default-src 'none'",
            "script-src 'sha256-\(hash)'",
            "style-src 'unsafe-inline'",
            "img-src mdstudio: data: https:",
            "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
        ].joined(separator: "; ")
    }

    private func respond(_ task: WKURLSchemeTask, _ url: URL, _ data: Data, _ mime: String, csp: String? = nil) {
        var headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        if let csp = csp { headers["Content-Security-Policy"] = csp }
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }
}
