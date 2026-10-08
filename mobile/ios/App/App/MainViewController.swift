import Capacitor
import UIKit

/// Registrácia lokálnych (app) Capacitor pluginov (Capacitor docs: Custom Native iOS Code).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(EsbluSecureStoragePlugin())
        bridge?.registerPluginInstance(EsbluAppleSignInPlugin())
    }
}
