import { getAddressFromPublicKey } from '@airgap/beacon-sdk'
import { ChangeDetectorRef, Component, OnInit } from '@angular/core'
import { ModalController } from '@ionic/angular'
import { ChromeMessagingService } from 'src/app/services/chrome-messaging.service'
import { WalletService } from 'src/app/services/local-wallet.service'
import { Action, ExtensionMessageOutputPayload, WalletInfo, WalletType } from 'src/extension/extension-client/Actions'

@Component({
  selector: 'app-add-ledger-connection',
  templateUrl: './add-ledger-connection.page.html',
  styleUrls: ['./add-ledger-connection.page.scss']
})
export class AddLedgerConnectionPage implements OnInit {
  public targetMethod: Action = Action.LEDGER_INIT
  public request: unknown | undefined

  public isLoading: boolean = true
  public success: boolean = false
  public error: string = ''

  constructor(
    private readonly modalController: ModalController,
    private readonly walletService: WalletService,
    private readonly chromeMessagingService: ChromeMessagingService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  public async ngOnInit(): Promise<void> {
    return this.connect()
  }

  public async connect(): Promise<void> {
    this.isLoading = true

    const response: ExtensionMessageOutputPayload<Action> = await this.chromeMessagingService.sendChromeMessage(
      this.targetMethod,
      {
        request: this.request,
        extras: undefined
      }
    )

    this.isLoading = false
    if (response && response.error) {
      console.log('received an error', response.error)
    } else {
      this.success = true
      if (this.targetMethod === Action.LEDGER_INIT) {
        const { data }: ExtensionMessageOutputPayload<Action.LEDGER_INIT> = response as ExtensionMessageOutputPayload<
          Action.LEDGER_INIT
        >
        if (data) {
          const walletInfo: WalletInfo<WalletType.LEDGER> = {
            address: await getAddressFromPublicKey(data.publicKey),
            publicKey: data.publicKey,
            type: WalletType.LEDGER,
            added: new Date().getTime(),
            info: undefined
          }
          await this.walletService.addAndActiveWallet(walletInfo)
        }
      }
      setTimeout(() => {
        return this.dismiss(true)
      }, 2000)
    }
    this.cdr.detectChanges()
  }

  public async dismiss(closeParent: boolean = false): Promise<void> {
    await this.modalController.dismiss(closeParent)
  }
}
