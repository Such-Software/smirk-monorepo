// Area H macOS accessibility helper for the desktop smoke.
//
// The release app has no DOM access, so the smoke reads and drives the app
// through the macOS accessibility tree. Built at run time into the run's
// owner-only directory by scripts/desktop-smoke-macos.sh:
//   swiftc -O -o <run>/bin/ax packages/e2e/scripts/H-cross-browser-desktop-macos-ax.swift
//
// Secret handling: `type` reads its text from stdin (never argv), types it into
// the focused field and prints nothing about it. `snapshot` never returns text
// field values, and returns no static text at all while a guard label applies
// (a password being typed, a phrase grid, a recovery phrase screen, the raw
// key export). `match` answers only true or false.
//
// `overlap` lists the owners of on-screen windows of other apps that sit in
// front of the app's window and intersect it (a notification banner, a
// dialog). Focus (Do Not Disturb) cannot be read without Full Disk Access, so
// the recorder checks the thing Focus is for directly: nothing foreign over
// the recorded rectangle.
//
// Every command prints one JSON object on stdout.
import ApplicationServices
import Cocoa
import CoreGraphics

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(2)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String) -> String { (attribute(element, name) as? String) ?? "" }

struct Node {
    let element: AXUIElement
    let role: String
    let subrole: String
    let label: String
    let value: String
}

func app(_ pidText: String) -> (AXUIElement, pid_t) {
    guard let pid = pid_t(pidText) else { fail("bad pid") }
    return (AXUIElementCreateApplication(pid), pid)
}

func mainWindow(_ application: AXUIElement) -> AXUIElement? {
    if let focused = attribute(application, kAXFocusedWindowAttribute) { return (focused as! AXUIElement) }
    if let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement], let first = windows.first { return first }
    return nil
}

func walk(_ root: AXUIElement) -> [Node] {
    var nodes: [Node] = []
    func visit(_ element: AXUIElement, _ depth: Int) {
        if depth > 90 || nodes.count > 8000 { return }
        let role = text(element, kAXRoleAttribute)
        let subrole = text(element, kAXSubroleAttribute)
        let label = [text(element, kAXTitleAttribute), text(element, kAXDescriptionAttribute)].filter { !$0.isEmpty }.joined(separator: " ")
        let value = role == "AXStaticText" ? text(element, kAXValueAttribute) : ""
        nodes.append(Node(element: element, role: role, subrole: subrole, label: label, value: value))
        for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { visit(child, depth + 1) }
    }
    visit(root, 0)
    return nodes
}

func isSecure(_ node: Node) -> Bool { node.subrole == "AXSecureTextField" || node.role == "AXSecureTextField" }
func isTextField(_ node: Node) -> Bool { !isSecure(node) && (node.role == "AXTextField" || node.role == "AXTextArea") }

func secureLength(_ node: Node) -> Int {
    if let count = attribute(node.element, kAXNumberOfCharactersAttribute) as? Int { return count }
    return ((attribute(node.element, kAXValueAttribute) as? String) ?? "").count
}

func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

/// The desktop guard: a static label when the window must not be recorded.
func guardLabel(_ nodes: [Node]) -> String? {
    if nodes.contains(where: { isSecure($0) && secureLength($0) > 0 }) { return "Password entry" }
    if nodes.filter(isTextField).count >= 6 { return "Recovery phrase entry" }
    let joined = nodes.filter { $0.role == "AXStaticText" }.map(\.value).joined(separator: "\n")
    if matches(joined, "(recovery phrase|write these words|seed phrase|12 words)") { return "Recovery phrase screen" }
    if joined.range(of: "(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})", options: .regularExpression) != nil { return "Private key text" }
    // Settings > Security > Export raw keys: 64-hex private keys with labels
    // that give the revealed panel away; its public material shares the
    // screen, so any 64-hex run on a Settings screen counts too.
    if matches(joined, "(private keys below|private (spend|view) key|private key \\(secp256k1\\)|slatepack secret key)") { return "Private key panel" }
    if matches(joined, "(Auto-lock wallet after|Export raw keys)")
        && joined.range(of: "(^|[^0-9a-fA-F])[0-9a-fA-F]{64}([^0-9a-fA-F]|$)", options: .regularExpression) != nil { return "Long hex in Settings" }
    return nil
}

func intersects(_ a: CGRect, _ b: CGRect) -> Bool { a.intersects(b) && !a.intersection(b).isEmpty }

/// Windows of other apps in front of the app's largest normal window that
/// intersect it, front to back. Owner names only.
func foreignWindowsOver(_ pid: pid_t) -> (CGRect?, [String]) {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return (nil, ["Window list unavailable"]) }
    func bounds(_ info: [String: Any]) -> CGRect? {
        guard let raw = info[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: raw) else { return nil }
        return rect
    }
    let owned = list.enumerated().filter { ($0.element[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0.element[kCGWindowLayer as String] as? Int) == 0 }
    guard let main = owned.max(by: { (bounds($0.element)?.width ?? 0) * (bounds($0.element)?.height ?? 0) < (bounds($1.element)?.width ?? 0) * (bounds($1.element)?.height ?? 0) }),
          let frame = bounds(main.element) else { return (nil, []) }
    var covering: [String] = []
    for info in list[..<main.offset] {
        if (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) { continue }
        if ((info[kCGWindowAlpha as String] as? Double) ?? 1) <= 0.01 { continue }
        guard let rect = bounds(info), rect.width > 1, rect.height > 1, intersects(rect, frame) else { continue }
        covering.append((info[kCGWindowOwnerName as String] as? String) ?? "unknown")
    }
    return (frame, covering)
}

func point(_ element: AXUIElement, _ name: String) -> CGPoint {
    guard let raw = attribute(element, name) else { return .zero }
    var result = CGPoint.zero
    AXValueGetValue(raw as! AXValue, .cgPoint, &result)
    return result
}

func size(_ element: AXUIElement, _ name: String) -> CGSize {
    guard let raw = attribute(element, name) else { return .zero }
    var result = CGSize.zero
    AXValueGetValue(raw as! AXValue, .cgSize, &result)
    return result
}

func activate(_ pid: pid_t) {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
}

func typeText(_ value: String, into pid: pid_t) {
    let source = CGEventSource(stateID: .hidSystemState)
    for character in value {
        let units = Array(String(character).utf16)
        let keyCode: CGKeyCode = character == " " ? 49 : 0
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.postToPid(pid)
        up.postToPid(pid)
        usleep(18_000)
    }
}

func pressKey(_ keyCode: CGKeyCode, into pid: pid_t) {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)?.postToPid(pid)
    CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)?.postToPid(pid)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("no command") }

switch command {
case "trusted":
    emit(["trusted": AXIsProcessTrusted()])

case "scale":
    let screen = NSScreen.screens.first
    emit(["scale": screen?.backingScaleFactor ?? 1, "width": screen?.frame.width ?? 0, "height": screen?.frame.height ?? 0])

case "frontmost":
    let front = NSWorkspace.shared.frontmostApplication
    emit(["pid": Int(front?.processIdentifier ?? 0), "bundle": front?.bundleIdentifier ?? ""])

case "activate":
    guard args.count >= 2 else { fail("usage: activate <pid>") }
    let (_, pid) = app(args[1])
    activate(pid)
    emit(["ok": true])

case "window":
    guard args.count >= 2 else { fail("usage: window <pid>") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { emit(["found": false]); exit(0) }
    let origin = point(window, kAXPositionAttribute)
    let extent = size(window, kAXSizeAttribute)
    emit(["found": true, "x": origin.x, "y": origin.y, "w": extent.width, "h": extent.height])

case "place":
    guard args.count >= 6, let x = Double(args[2]), let y = Double(args[3]), let w = Double(args[4]), let h = Double(args[5]) else { fail("usage: place <pid> x y w h") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    var origin = CGPoint(x: x, y: y)
    var extent = CGSize(width: w, height: h)
    AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &extent)!)
    emit(["ok": true])

case "snapshot":
    // Static texts and control labels in tree order, plus the guard verdict.
    guard args.count >= 2 else { fail("usage: snapshot <pid>") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { emit(["window": false]); exit(0) }
    let nodes = walk(window)
    let label = guardLabel(nodes)
    let secureFields = nodes.filter(isSecure).count
    if let label {
        emit(["window": true, "guard": label, "secureFields": secureFields, "texts": [], "buttons": []])
    } else {
        emit([
            "window": true,
            "guard": NSNull(),
            "secureFields": secureFields,
            "textFields": nodes.filter(isTextField).count,
            "texts": nodes.filter { $0.role == "AXStaticText" && !$0.value.isEmpty }.map(\.value),
            "buttons": nodes.filter { $0.role == "AXButton" || $0.role == "AXLink" }.map(\.label),
        ])
    }

case "press":
    // press <pid> <role|any> <label regex> [nth]: AXPress on the nth match.
    guard args.count >= 4 else { fail("usage: press <pid> <role> <regex> [nth]") }
    let (application, pid) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let nth = args.count >= 5 ? Int(args[4]) ?? 0 : 0
    let wanted = args[2]
    let hits = walk(window).filter { (wanted == "any" || $0.role == wanted) && matches($0.label, args[3]) }
    guard hits.count > nth else { emit(["ok": false, "matches": hits.count]); exit(0) }
    activate(pid)
    let result = AXUIElementPerformAction(hits[nth].element, kAXPressAction as CFString)
    emit(["ok": result == .success])

case "overlap":
    // overlap <pid>: the app window's frame and the owners of foreign windows over it.
    guard args.count >= 2 else { fail("usage: overlap <pid>") }
    let (_, pid) = app(args[1])
    let (frame, covering) = foreignWindowsOver(pid)
    guard let frame else { emit(["window": false, "covering": covering]); exit(0) }
    emit(["window": true, "x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height, "covering": covering])

case "match":
    // match <pid> <regex>: true when a static text in the window matches. Never returns text.
    guard args.count >= 3 else { fail("usage: match <pid> <regex>") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { emit(["window": false, "match": false]); exit(0) }
    let found = walk(window).contains { $0.role == "AXStaticText" && matches($0.value, args[2]) }
    emit(["window": true, "match": found])

case "find-after":
    // find-after <pid> <anchor text regex> <role>: whether press-after would find a control. Presses nothing.
    guard args.count >= 4 else { fail("usage: find-after <pid> <anchor> <role>") }
    let (application, _) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let nodes = walk(window)
    guard let anchor = nodes.firstIndex(where: { $0.role == "AXStaticText" && matches($0.value, args[2]) }) else { emit(["ok": false, "anchor": false]); exit(0) }
    emit(["ok": nodes[(anchor + 1)...].contains(where: { $0.role == args[3] }), "anchor": true])

case "press-after":
    // press-after <pid> <anchor text regex> <role>: the first control after a static text.
    guard args.count >= 4 else { fail("usage: press-after <pid> <anchor> <role>") }
    let (application, pid) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let nodes = walk(window)
    guard let anchor = nodes.firstIndex(where: { $0.role == "AXStaticText" && matches($0.value, args[2]) }) else { emit(["ok": false, "anchor": false]); exit(0) }
    guard let target = nodes[(anchor + 1)...].first(where: { $0.role == args[3] }) else { emit(["ok": false, "anchor": true]); exit(0) }
    activate(pid)
    emit(["ok": AXUIElementPerformAction(target.element, kAXPressAction as CFString) == .success])

case "focus":
    // focus <pid> <text|secure> <index>
    guard args.count >= 4, let index = Int(args[3]) else { fail("usage: focus <pid> <text|secure> <index>") }
    let (application, pid) = app(args[1])
    guard let window = mainWindow(application) else { fail("no window") }
    let fields = walk(window).filter { args[2] == "secure" ? isSecure($0) : isTextField($0) }
    guard fields.count > index else { emit(["ok": false, "fields": fields.count]); exit(0) }
    activate(pid)
    let result = AXUIElementSetAttributeValue(fields[index].element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    emit(["ok": result == .success])

case "type":
    // type <pid>: the text arrives on stdin and goes only to the app.
    guard args.count >= 2 else { fail("usage: type <pid>") }
    let (_, pid) = app(args[1])
    var value = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    if value.hasSuffix("\n") { value.removeLast() }
    activate(pid)
    usleep(150_000)
    typeText(value, into: pid)
    value = String(repeating: " ", count: value.count)
    emit(["ok": true])

case "key":
    // key <pid> <escape|return|tab>
    guard args.count >= 3 else { fail("usage: key <pid> <name>") }
    let (_, pid) = app(args[1])
    let codes: [String: CGKeyCode] = ["escape": 53, "return": 36, "tab": 48]
    guard let code = codes[args[2]] else { fail("unknown key") }
    activate(pid)
    pressKey(code, into: pid)
    emit(["ok": true])

default:
    fail("unknown command")
}
