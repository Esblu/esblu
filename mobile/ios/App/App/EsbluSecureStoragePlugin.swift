import Capacitor
import Foundation
import Security

/// Bezpečné úložisko auth relácie (Mobile Platform 2026-10-08) — iOS Keychain.
///
/// Generic password položky (service `com.esblu.app.secure-storage`, account = kľúč),
/// dostupné až po prvom odomknutí a IBA na tomto zariadení (nezálohujú sa
/// do iCloud / na nové zariadenie). Hodnoty sa nikdy nelogujú.
@objc(EsbluSecureStoragePlugin)
public class EsbluSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EsbluSecureStoragePlugin"
    public let jsName = "EsbluSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.esblu.app.secure-storage"

    private func validKey(_ key: String?) -> String? {
        guard let key = key, key.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil else { return nil }
        return key
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = validKey(call.getString("key")) else { call.reject("INVALID_KEY"); return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = validKey(call.getString("key")), let value = call.getString("value") else {
            call.reject("INVALID_ARGUMENTS"); return
        }
        let data = Data(value.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(key)
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        status == errSecSuccess ? call.resolve() : call.reject("WRITE_FAILED")
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = validKey(call.getString("key")) else { call.reject("INVALID_KEY"); return }
        SecItemDelete(baseQuery(key) as CFDictionary)
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(query as CFDictionary)
        call.resolve()
    }
}
