import Cocoa

/// Headless proof of open -> edit -> save through the same bridge the UI uses.
/// Stdout carries exactly one JSON line; everything else goes to stderr.
enum SelfTest {
    static let marker = "\n<!-- mdstudio-selftest -->"
    // Read by the watchdog thread and written by the main actor: every access takes the lock.
    private static let lock = NSLock()
    private static var _stage = "start"
    private static var _result: [(String, Any)] = []
    static var stage: String {
        get { lock.lock(); defer { lock.unlock() }; return _stage }
        set { lock.lock(); defer { lock.unlock() }; _stage = newValue }
    }
    static var result: [(String, Any)] {
        get { lock.lock(); defer { lock.unlock() }; return _result }
        set { lock.lock(); defer { lock.unlock() }; _result = newValue }
    }
    static var expectMath = false
    static var expectTables = false

    static func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

    private static var _finished = false
    static func finish(_ pairs: [(String, Any)], error: String? = nil) -> Never {
        // Idempotent: the watchdog thread and the main actor may both get here; only the first prints and exits.
        lock.lock()
        let first = !_finished
        _finished = true
        lock.unlock()
        if !first { while true { sleep(60) } }
        var parts: [String] = []
        var all = pairs
        if let e = error { all.append(("error", e)) }
        for (k, v) in all {
            let data = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])) ?? Data("null".utf8)
            parts.append("\"\(k)\":" + String(decoding: data, as: UTF8.self))
        }
        print("{" + parts.joined(separator: ",") + "}")
        fflush(stdout)
        let m = Dictionary(uniqueKeysWithValues: pairs.map { ($0.0, $0.1) })
        if (m["mode"] as? String) == "loadfail" {
            exit(error == nil && (m["load_failed"] as? Bool) == true && (m["save_refused"] as? Bool) == true
                 && (m["disk_unchanged"] as? Bool) == true ? 0 : 1)
        }
        let ok = error == nil && (m["opened"] as? Bool) == true && (m["saved_bytes_match"] as? Bool) == true
            && (m["dirty_after_edit"] as? Bool) == true
            && (m["rendered_math"] as? Int) == (m["math_nonzero_boxes"] as? Int)
            && (!expectMath || ((m["rendered_math"] as? Int) ?? 0) > 0)
            && (!expectTables || ((m["rendered_tables"] as? Int) ?? 0) > 0)
            && (m["csp_active"] as? Bool) == true
            && (m["csp_blocked_injected_script"] as? Bool) == true
            && (m["injection_probe_ran"] as? Bool) == true
            && (m["pasteboard_unchanged"] as? Bool) == true
        exit(ok ? 0 : 1)
    }

    static func start(input: URL, output: URL) {
        // Background-thread watchdog: fires even if the main run loop is wedged in a modal.
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
            finish(result, error: "timeout waiting for \(stage)")
        }
        Task { @MainActor in await run(input: input, output: output) }
    }

    @MainActor static func run(input: URL, output: URL) async {
        do {
            stage = "open"
            let d: NSDocument = try await withCheckedThrowingContinuation { cont in
                NSDocumentController.shared.openDocument(withContentsOf: input, display: false) { doc, _, err in
                    if let doc = doc { cont.resume(returning: doc) }
                    else { cont.resume(throwing: err ?? NSError(domain: "MarkdownStudio", code: 9,
                            userInfo: [NSLocalizedDescriptionKey: "open failed"])) }
                }
            }
            log("opened document")
            guard let doc = d as? Document else { finish(result, error: "wrong document class") }
            doc.makeWindowControllers()
            guard let wc = doc.windowController else { finish(result, error: "no window controller") }

            stage = "ready"
            while !(wc.isReady && wc.loadCompleted) { try await Task.sleep(nanoseconds: 50_000_000) }

            if ProcessInfo.processInfo.environment["MDSTUDIO_TEST_SKIP_NUL_CHECK"] != nil {
                // Forced load failure: the editor must refuse the file, and Save must refuse too.
                var out: [(String, Any)] = [("mode", "loadfail"), ("load_failed", wc.loadError != nil)]
                let before = try Data(contentsOf: input)
                var refused = true
                for target in [input, output] {
                    do {
                        try await doc.save(to: target, ofType: doc.fileType ?? "net.daringfireball.markdown", for: .saveAsOperation)
                        refused = false
                    } catch { log("save refused: \(error.localizedDescription)") }
                }
                let after = try Data(contentsOf: input)
                out.append(("save_refused", refused))
                out.append(("output_created", FileManager.default.fileExists(atPath: output.path)))
                out.append(("disk_unchanged", before == after && !FileManager.default.fileExists(atPath: output.path)))
                finish(out)
            }

            stage = "probe"
            let probe = """
            await new Promise(r => setTimeout(r, 600));   // let injected onerror handlers fire if they can
            let evalBlocked = false;
            try { (0, eval)('1'); } catch (e) { evalBlocked = true; }   // control: CSP is really applied

            const p = document.getElementById('preview');
            const maths = Array.from(p.querySelectorAll('math'));
            let nz = 0;
            for (const m of maths) { const r = m.getBoundingClientRect(); if (r.width > 0 && r.height > 0) nz++; }
            const st = window.__mdstudio.getState();
            return { tables: p.querySelectorAll('table').length,
                     math: maths.length, nonzero: nz, text: st.text, name: st.name,
                     evalBlocked: evalBlocked,
                     injected: (typeof window.__pwned_script !== 'undefined') || (typeof window.__pwned_onerror !== 'undefined') };
            """
            let v: Any? = try await withCheckedThrowingContinuation { cont in
                wc.call(probe) { cont.resume(with: $0) }
            }
            guard let info = v as? [String: Any] else { finish(result, error: "probe returned no object") }
            let rawData = try Data(contentsOf: input)
            let hasBOM = rawData.starts(with: [0xEF, 0xBB, 0xBF])
            let raw = String(decoding: hasBOM ? rawData.dropFirst(3) : rawData[...], as: UTF8.self)
            let ending = raw.contains("\r\n") ? "\r\n" : (raw.contains("\r") ? "\r" : "\n")
            let norm = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            let opened = (info["text"] as? String) == norm && (info["name"] as? String) == input.lastPathComponent
            let math = (info["math"] as? Int) ?? -1
            let nonzero = (info["nonzero"] as? Int) ?? -2
            // A document that looks like math / a table must actually render some (guards a vacuous pass).
            expectMath = raw.contains("$")
            expectTables = raw.range(of: #"\|\s*:?-{3,}"#, options: .regularExpression) != nil
            result = [("opened", opened), ("rendered_tables", (info["tables"] as? Int) ?? -1),
                      ("rendered_math", math), ("math_nonzero_boxes", nonzero),
                      ("saved_bytes_match", false), ("dirty_after_edit", false),
                      ("csp_active", (info["evalBlocked"] as? Bool) ?? false),
                      ("csp_blocked_injected_script", (info["injected"] as? Bool) == false)]

            stage = "edit"
            let _: Any? = try await withCheckedThrowingContinuation { cont in
                wc.call("return window.__mdstudio.native.appendText(text);", args: ["text": marker]) { cont.resume(with: $0) }
            }

            stage = "dirty"
            var dirty = false
            for _ in 0..<40 {
                if doc.isDocumentEdited { dirty = true; break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            result[5] = ("dirty_after_edit", dirty)

            stage = "save"
            try await doc.save(to: output, ofType: doc.fileType ?? "net.daringfireball.markdown", for: .saveAsOperation)
            let written = try Data(contentsOf: output)
            var expected = norm + marker
            if ending != "\n" { expected = expected.replacingOccurrences(of: "\n", with: ending) }
            if hasBOM { expected = "\u{FEFF}" + expected }
            result[4] = ("saved_bytes_match", written == Data(expected.utf8))
            result.append(("line_ending", ending == "\r\n" ? "CRLF" : (ending == "\r" ? "CR" : "LF")))
            result.append(("bom", hasBOM))

            // Injection probe, AFTER the byte compare so the saved file stays exact: put the attack
            // payload into the live document and make sure nothing runs and the clipboard is untouched.
            stage = "inject"
            let pbBefore = NSPasteboard.general.changeCount   // count only; contents never read
            let payload = "\n\n<img src=x onerror=\"window.__pwned_onerror=1;window.webkit.messageHandlers.mdstudio.postMessage({type:'copy',text:'pwned'})\">\n\n<script>window.__pwned_script=1;window.webkit.messageHandlers.mdstudio.postMessage({type:'copy',text:'pwned'})</script>\n"
            let _: Any? = try await withCheckedThrowingContinuation { cont in
                wc.call("return window.__mdstudio.native.appendText(text);", args: ["text": payload]) { cont.resume(with: $0) }
            }
            let inj: Any? = try await withCheckedThrowingContinuation { cont in
                wc.call("""
                await new Promise(r => setTimeout(r, 1000));   // let onerror / script fire if they can
                const ed = document.getElementById('editor');
                return { present: !!ed && ed.value.indexOf('__pwned_onerror') >= 0,
                         img: document.querySelectorAll('#preview img[src="x"]').length,
                         onerror: typeof window.__pwned_onerror !== 'undefined',
                         script: typeof window.__pwned_script !== 'undefined' };
                """) { cont.resume(with: $0) }
            }
            let ij = (inj as? [String: Any]) ?? [:]
            let pbAfter = NSPasteboard.general.changeCount
            let blocked = (ij["onerror"] as? Bool) == false && (ij["script"] as? Bool) == false
            result[7] = ("csp_blocked_injected_script", blocked && (info["injected"] as? Bool) == false)
            result.append(("injection_probe_ran", (ij["present"] as? Bool) == true))
            result.append(("injected_img_elements", (ij["img"] as? Int) ?? -1))
            result.append(("pasteboard_unchanged", pbBefore == pbAfter))
            finish(result)
        } catch {
            finish(result, error: "\(stage): \(error.localizedDescription)")
        }
    }
}
