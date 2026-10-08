import AuthenticationServices
import Capacitor
import Foundation

/// Natívne Sign in with Apple (Mobile Platform 2026-10-08).
///
/// Vráti identityToken (JWT od Apple) pre `supabase.auth.signInWithIdToken({ provider: "apple", token, nonce })`.
/// JS posiela SHA-256 hash nonce; surový nonce ostáva v JS a overí ho Supabase.
/// USER ACTION (Apple Developer): capability „Sign in with Apple" na App ID
/// `com.esblu.app` + Apple provider v Supabase. Bez capability ASAuthorization
/// zlyhá → JS dostane chybu a nič sa neprihlási (fail closed).
@objc(EsbluAppleSignInPlugin)
public class EsbluAppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "EsbluAppleSignInPlugin"
    public let jsName = "EsbluAppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?

    @objc func signIn(_ call: CAPPluginCall) {
        guard let hashedNonce = call.getString("nonce"), hashedNonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            call.reject("INVALID_NONCE"); return
        }
        pendingCall = call
        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            request.nonce = hashedNonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            pendingCall?.reject("NO_IDENTITY_TOKEN"); pendingCall = nil; return
        }
        pendingCall?.resolve(["identityToken": token])
        pendingCall = nil
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        pendingCall?.reject(canceled ? "CANCELED" : "APPLE_SIGN_IN_FAILED")
        pendingCall = nil
    }
}
