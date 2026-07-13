import SwiftUI
import WebKit
import Foundation
import Security
import Darwin

struct WebView: NSViewRepresentable {
    let url: URL
    let capability: String

    final class Coordinator: NSObject, WKNavigationDelegate {
        let allowedOrigin: URL

        init(allowedOrigin: URL) {
            self.allowedOrigin = allowedOrigin
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            let allowed = target.scheme == allowedOrigin.scheme && target.host == allowedOrigin.host && target.port == allowedOrigin.port
            decisionHandler(allowed ? .allow : .cancel)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(allowedOrigin: url)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        if ProcessInfo.processInfo.environment["COFORGE_ENABLE_WEB_INSPECTOR"] == "1" {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        let script = """
        (() => {
          const capability = \(String(reflecting: capability));
          const originalFetch = window.fetch.bind(window);
          window.fetch = (input, init = {}) => {
            const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
            if (target.origin === location.origin) {
              const headers = new Headers(input instanceof Request ? input.headers : undefined);
              new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
              headers.set('X-COFORGE-Capability', capability);
              init = { ...init, headers };
            }
            return originalFetch(input, init);
          };
        })();
        """
        config.userContentController.addUserScript(WKUserScript(
            source: script,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.allowsMagnification = false
        wv.navigationDelegate = context.coordinator
        return wv
    }
    func updateNSView(_ wv: WKWebView, context: Context) {
        if wv.url != url {
            var request = URLRequest(url: url)
            request.setValue(capability, forHTTPHeaderField: "X-COFORGE-Capability")
            wv.load(request)
        }
    }
}

final class LocalServer: ObservableObject {
    static let shared = LocalServer()

    @Published var isReady = false
    @Published var status = "正在启动本地分析服务..."

    let port: Int
    let url: URL
    let capability: String

    private var process: Process?
    private var logHandle: FileHandle?

    private init() {
        let chosenPort = Int.random(in: 18100...18999)
        port = chosenPort
        url = URL(string: "http://127.0.0.1:\(chosenPort)")!
        capability = Self.randomCapability()
    }

    func start() {
        guard process == nil else { return }

        guard let resources = Bundle.main.resourceURL else {
            status = "无法定位应用资源目录"
            return
        }

        let appRoot = resources.appendingPathComponent("app", isDirectory: true)
        let dbPath = resources.appendingPathComponent("data/coal-demo.db").path
        let bundledNode = resources.appendingPathComponent("node/bin/node").path
        let credentialHelper = resources.appendingPathComponent("credential-helper").path
        #if arch(x86_64)
        let reasonixPlatform = "darwin-x64"
        #elseif arch(arm64)
        let reasonixPlatform = "darwin-arm64"
        #else
        let reasonixPlatform = "unsupported"
        #endif
        let reasonixRoot = resources.appendingPathComponent("reasonix", isDirectory: true)
        let reasonixBinary = reasonixRoot.appendingPathComponent("\(reasonixPlatform)/reasonix").path
        let mcpEntrypoint = appRoot.appendingPathComponent("coforge-mcp-server.cjs").path
        let nodePath = bundledNode

        guard FileManager.default.fileExists(atPath: appRoot.appendingPathComponent("server.js").path) else {
            status = "缺少本地服务入口，请重新构建桌面应用"
            return
        }

        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            status = "缺少 Node 运行时，请重新构建桌面应用"
            return
        }

        guard FileManager.default.isExecutableFile(atPath: credentialHelper) else {
            status = "缺少系统凭证库组件，请重新构建桌面应用"
            return
        }

        guard FileManager.default.isExecutableFile(atPath: reasonixBinary) else {
            status = "缺少内置 Reasonix 运行时，请重新构建桌面应用"
            return
        }

        guard FileManager.default.fileExists(atPath: mcpEntrypoint) else {
            status = "缺少 COFORGE 工具桥，请重新构建桌面应用"
            return
        }

        do {
            let support = try appSupportDirectory()
            let logURL = support.appendingPathComponent("coforge-server.log")
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            logHandle = try FileHandle(forWritingTo: logURL)

            let child = Process()
            child.executableURL = URL(fileURLWithPath: nodePath)
            child.currentDirectoryURL = appRoot
            child.arguments = ["server.js"]

            let reasonixEnabled = ProcessInfo.processInfo.environment["COFORGE_REASONIX_ENABLED"] == "0" ? "0" : "1"
            child.environment = [
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "NODE_ENV": "production",
                "PORT": String(port),
                "HOSTNAME": "127.0.0.1",
                "DB_PATH": dbPath,
                "COFORGE_DESKTOP": "1",
                "COFORGE_DESKTOP_CAPABILITY": capability,
                "COFORGE_CONFIG_DIR": support.path,
                "COFORGE_CREDENTIAL_HELPER": credentialHelper,
                "COFORGE_RESOURCES_DIR": resources.path,
                "COFORGE_NODE_BINARY": nodePath,
                "COFORGE_REASONIX_PACKAGE_ROOT": reasonixRoot.path,
                "COFORGE_REASONIX_INTEGRITY_MANIFEST": reasonixRoot.appendingPathComponent("packaged-manifest.json").path,
                "COFORGE_MCP_ENTRYPOINT": mcpEntrypoint,
                "COFORGE_QUERY_AUDIT_PATH": support.appendingPathComponent("audit/query-events.jsonl").path,
                "COFORGE_MCP_AUDIT_PATH": support.appendingPathComponent("audit/mcp-events.jsonl").path,
                "COFORGE_REASONIX_ENABLED": reasonixEnabled
            ]
            child.standardOutput = logHandle
            child.standardError = logHandle

            try child.run()
            process = child
            pollHealth()
        } catch {
            status = "本地服务启动失败：\(error.localizedDescription)"
        }
    }

    func stop() {
        process?.terminate()
        process = nil
        try? logHandle?.close()
        logHandle = nil
    }

    private func pollHealth() {
        let healthURL = url.appendingPathComponent("api/health")
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<120 {
                if self.isHealthy(healthURL) {
                    DispatchQueue.main.async {
                        self.isReady = true
                        self.status = "本地分析服务已就绪"
                    }
                    return
                }
                Thread.sleep(forTimeInterval: 0.25)
            }

            DispatchQueue.main.async {
                self.status = "本地服务启动超时，请查看应用支持目录中的 coforge-server.log"
            }
        }
    }

    private func isHealthy(_ url: URL) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        var request = URLRequest(url: url)
        request.setValue(capability, forHTTPHeaderField: "X-COFORGE-Capability")
        let task = URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                ok = true
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 1)
        return ok
    }

    private static func randomCapability() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "Unable to create desktop capability")
        return Data(bytes).base64EncodedString()
    }

    private func appSupportDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dir = base.appendingPathComponent("COFORGE", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationSignalSources: [DispatchSourceSignal] = []
    private var isTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installTerminationSignalHandler(SIGTERM)
        installTerminationSignalHandler(SIGINT)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        LocalServer.shared.stop()
    }

    private func installTerminationSignalHandler(_ signalNumber: Int32) {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler { [weak self] in
            self?.terminateAfterSignal()
        }
        source.resume()
        terminationSignalSources.append(source)
    }

    private func terminateAfterSignal() {
        guard !isTerminating else { return }
        isTerminating = true
        LocalServer.shared.stop()
        NSApp.terminate(nil)
    }
}

@main
struct COFORGEApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1440, height: 900)
    }
}

struct ContentView: View {
    @StateObject private var server = LocalServer.shared

    var body: some View {
        ZStack {
            if server.isReady {
                WebView(url: server.url, capability: server.capability)
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 14) {
                    Text("CO")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 58, height: 58)
                        .background(
                            LinearGradient(
                                colors: [Color(red: 0.04, green: 0.41, blue: 0.85), Color(red: 0.51, green: 0.31, blue: 0.87)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                    Text("COFORGE")
                        .font(.system(size: 16, weight: .semibold))

                    Text(server.status)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)

                    ProgressView()
                        .controlSize(.small)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.05, green: 0.07, blue: 0.09))
            }
        }
        .onAppear {
            NSApp.appearance = NSAppearance(named: .darkAqua)
            server.start()
        }
    }
}
