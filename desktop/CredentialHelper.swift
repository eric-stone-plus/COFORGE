import Foundation
import Security
import Darwin

private let protocolVersion = 1
private let allowedCredential = "provider-api-key"
private let maxInputBytes = 64 * 1024
private let maxSecretBytes = 32 * 1024

private struct Request: Decodable {
    let version: Int
    let operation: String
    let credential: String
    let secret: String?
}

private struct Response: Encodable {
    let version: Int
    let ok: Bool
    let found: Bool?
    let secret: String?
}

private enum HelperError: Error {
    case invalidRequest
    case keychain(OSStatus)
}

private let appIdentifier = "com.coforge.desktop"
private let nodeIdentifier = "com.coforge.desktop.node"
private let helperIdentifier = "com.coforge.desktop.credential-helper"

private var keychainService: String {
    let scope = CredentialHelperBuildConfig.requiresDeveloperID
        ? CredentialHelperBuildConfig.expectedTeamIdentifier
        : "development"
    return "com.coforge.desktop.credentials.\(scope)"
}

private func codeRequirement(identifier: String) throws -> SecRequirement {
    var expression = "identifier \(String(reflecting: identifier))"
    if CredentialHelperBuildConfig.requiresDeveloperID {
        let teamIdentifier = CredentialHelperBuildConfig.expectedTeamIdentifier
        guard teamIdentifier.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else {
            throw HelperError.invalidRequest
        }
        expression += " and anchor apple generic"
        expression += " and certificate leaf[subject.OU] = \(String(reflecting: teamIdentifier))"
        expression += " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
    }

    var requirement: SecRequirement?
    let status = SecRequirementCreateWithString(expression as CFString, [], &requirement)
    guard status == errSecSuccess, let requirement else { throw HelperError.invalidRequest }
    return requirement
}

private func liveCode(pid: pid_t) throws -> SecCode {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    let status = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
    guard status == errSecSuccess, let code else { throw HelperError.invalidRequest }
    return code
}

private func verifyLiveCode(pid: pid_t, identifier: String) throws {
    let code = try liveCode(pid: pid)
    let requirement = try codeRequirement(identifier: identifier)
    guard SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
        throw HelperError.invalidRequest
    }
}

private func verifySelf() throws {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
        throw HelperError.invalidRequest
    }
    let requirement = try codeRequirement(identifier: helperIdentifier)
    guard SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
        throw HelperError.invalidRequest
    }
}

private func processExecutable(pid: pid_t) -> URL? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().standardizedFileURL
}

private func parentPID(of pid: pid_t) -> pid_t? {
    var info = proc_bsdinfo()
    let expectedSize = MemoryLayout<proc_bsdinfo>.stride
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, pointer, Int32(expectedSize))
    }
    guard result == expectedSize, info.pbi_ppid > 0 else { return nil }
    return pid_t(info.pbi_ppid)
}

private func verifyCaller() throws {
    let helper = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().standardizedFileURL
    let resources = helper.deletingLastPathComponent()
    let expectedNode = resources
        .appendingPathComponent("node/bin/node")
        .resolvingSymlinksInPath()
        .standardizedFileURL
    let expectedApp = resources
        .deletingLastPathComponent()
        .appendingPathComponent("MacOS/COFORGE")
        .resolvingSymlinksInPath()
        .standardizedFileURL
    let appBundle = resources
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .standardizedFileURL

    let nodePID = getppid()
    guard processExecutable(pid: nodePID) == expectedNode,
          let appPID = parentPID(of: nodePID),
          processExecutable(pid: appPID) == expectedApp else {
        throw HelperError.invalidRequest
    }

    try verifySelf()
    try verifyLiveCode(pid: nodePID, identifier: nodeIdentifier)
    try verifyLiveCode(pid: appPID, identifier: appIdentifier)

    var staticCode: SecStaticCode?
    let createStatus = SecStaticCodeCreateWithPath(appBundle as CFURL, [], &staticCode)
    guard createStatus == errSecSuccess, let staticCode else { throw HelperError.invalidRequest }
    let validationFlags = SecCSFlags(
        rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode
    )
    let appRequirement = try codeRequirement(identifier: appIdentifier)
    guard SecStaticCodeCheckValidity(staticCode, validationFlags, appRequirement) == errSecSuccess else {
        throw HelperError.invalidRequest
    }
}

private func baseQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: allowedCredential,
    ]
}

private func readSecret() throws -> String? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess,
          let data = item as? Data,
          data.count <= maxSecretBytes,
          let secret = String(data: data, encoding: .utf8) else {
        throw HelperError.keychain(status)
    }
    return secret
}

private func writeSecret(_ secret: String) throws {
    guard !secret.isEmpty,
          !secret.contains("\0"),
          let data = secret.data(using: .utf8),
          data.count <= maxSecretBytes else {
        throw HelperError.invalidRequest
    }

    let update: [String: Any] = [
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let status = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
        var item = baseQuery()
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw HelperError.keychain(addStatus) }
        return
    }
    guard status == errSecSuccess else { throw HelperError.keychain(status) }
}

private func deleteSecret() throws {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        throw HelperError.keychain(status)
    }
}

private func respond(_ response: Response) throws {
    let data = try JSONEncoder().encode(response)
    FileHandle.standardOutput.write(data)
}

private func run() throws {
    try verifyCaller()
    let input = FileHandle.standardInput.readData(ofLength: maxInputBytes + 1)
    guard !input.isEmpty, input.count <= maxInputBytes else { throw HelperError.invalidRequest }
    let request = try JSONDecoder().decode(Request.self, from: input)
    guard request.version == protocolVersion, request.credential == allowedCredential else {
        throw HelperError.invalidRequest
    }

    switch request.operation {
    case "status":
        try respond(Response(version: protocolVersion, ok: true, found: nil, secret: nil))
    case "read":
        let secret = try readSecret()
        try respond(Response(version: protocolVersion, ok: true, found: secret != nil, secret: secret))
    case "write":
        guard let secret = request.secret else { throw HelperError.invalidRequest }
        try writeSecret(secret)
        try respond(Response(version: protocolVersion, ok: true, found: nil, secret: nil))
    case "delete":
        try deleteSecret()
        try respond(Response(version: protocolVersion, ok: true, found: nil, secret: nil))
    default:
        throw HelperError.invalidRequest
    }
}

@main
private enum CredentialHelperMain {
    static func main() {
        do {
            try run()
        } catch {
            // The caller maps any nonzero exit to a generic error and never exposes Keychain details.
            exit(EXIT_FAILURE)
        }
    }
}
