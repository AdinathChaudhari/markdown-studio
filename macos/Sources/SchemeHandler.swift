import Foundation
import WebKit

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
            respond(task, url, data, "text/html; charset=utf-8")
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

    private func respond(_ task: WKURLSchemeTask, _ url: URL, _ data: Data, _ mime: String) {
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store",
        ])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }
}
