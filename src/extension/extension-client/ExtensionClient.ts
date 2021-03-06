import {
  AppMetadata,
  AppMetadataManager,
  BeaconClient,
  BeaconMessage,
  BeaconMessageType,
  ChromeMessageTransport,
  ChromeStorage,
  ConnectionContext,
  ExtensionMessage,
  ExtensionMessageTarget,
  getAccountIdentifier,
  getAddressFromPublicKey,
  P2PPairInfo,
  P2PTransport,
  PermissionInfo,
  PermissionManager,
  PermissionRequest,
  PermissionResponse,
  Serializer
} from '@airgap/beacon-sdk'
import { BeaconEvent, BeaconEventHandler } from '@airgap/beacon-sdk/dist/events'
import * as sodium from 'libsodium-wrappers'

import { AirGapOperationProvider, LocalSigner } from '../AirGapSigner'

import { ActionHandlerFunction, ActionMessageHandler } from './action-handler/ActionMessageHandler'
import { Action, ExtensionMessageInputPayload, WalletInfo, WalletType } from './Actions'
import { ExtensionClientOptions } from './ExtensionClientOptions'
import { Logger } from './Logger'
import { MessageHandler } from './message-handler/MessageHandler'
import { ToBackgroundMessageHandler } from './message-handler/ToBackgroundMessageHandler'
import { ToExtensionMessageHandler } from './message-handler/ToExtensionMessageHandler'
import { ToPageMessageHandler } from './message-handler/ToPageMessageHandler'
import { PopupManager } from './PopupManager'
import { Signer } from './Signer'

const logger: Logger = new Logger('ExtensionClient')

export class ExtensionClient extends BeaconClient {
  public pendingRequests: { message: BeaconMessage; connectionContext: ConnectionContext }[] = []

  public readonly operationProvider: AirGapOperationProvider = new AirGapOperationProvider()
  public readonly signer: Signer = new LocalSigner()

  public readonly popupManager: PopupManager = new PopupManager()

  public readonly permissionManager: PermissionManager
  public readonly appMetadataManager: AppMetadataManager

  private p2pTransport: P2PTransport | undefined

  private readonly transport: ChromeMessageTransport

  private readonly listeners: any[] = []

  constructor(config: ExtensionClientOptions) {
    super({ name: config.name, storage: new ChromeStorage() })

    const events = new BeaconEventHandler({
      [BeaconEvent.P2P_LISTEN_FOR_CHANNEL_OPEN]: {
        handler: async (syncInfo: P2PPairInfo): Promise<void> => {
          console.log('Pairing QR data: ', syncInfo)
        }
      },
      [BeaconEvent.P2P_CHANNEL_CONNECT_SUCCESS]: {
        handler: async (newPeer: P2PPairInfo): Promise<void> => {
          if (newPeer) {
            const walletInfo: WalletInfo<WalletType.P2P> = {
              address: '',
              publicKey: '',
              type: WalletType.P2P,
              added: new Date().getTime(),
              info: newPeer
            }
            await this.addWallet(walletInfo)
            await this.storage.set('ACTIVE_WALLET' as any, walletInfo)
          }

          this.popupManager
            .sendToActivePopup({
              target: ExtensionMessageTarget.EXTENSION,
              sender: 'background',
              payload: { beaconEvent: BeaconEvent.P2P_CHANNEL_CONNECT_SUCCESS }
            })
            .catch(console.error)
        }
      }
    })

    this.transport = new ChromeMessageTransport(config.name)
    this.permissionManager = new PermissionManager(new ChromeStorage())
    this.appMetadataManager = new AppMetadataManager(new ChromeStorage())

    this.keyPair
      .then((keyPair: sodium.KeyPair) => {
        this.p2pTransport = new P2PTransport(config.name, keyPair, new ChromeStorage(), events, false)

        this.p2pTransport.connect().catch((p2pClientStartError: Error) => {
          logger.error('p2pClientStartError', p2pClientStartError)
        })

        this.p2pTransport
          .addListener(message => {
            if (typeof message === 'string') {
              this.sendToPage(message, false)
            } else {
              console.error('Message is not string!', message)
            }
          })
          .catch(console.error)
      })
      .catch(console.error)

    const messageHandlerMap: Map<string, MessageHandler> = new Map<string, MessageHandler>()
    messageHandlerMap.set(ExtensionMessageTarget.EXTENSION, new ToExtensionMessageHandler(this))
    messageHandlerMap.set(ExtensionMessageTarget.PAGE, new ToPageMessageHandler(this))
    messageHandlerMap.set(ExtensionMessageTarget.BACKGROUND, new ToBackgroundMessageHandler(this.handleMessage))

    const transportListener: any = async (
      message: ExtensionMessage<unknown>,
      connectionContext: ConnectionContext
    ): Promise<void> => {
      const handler: MessageHandler = messageHandlerMap.get(message.target) || new MessageHandler()
      let beaconConnected: boolean = false
      if (this.p2pTransport) {
        const activeWallet: WalletInfo = await this.storage.get('ACTIVE_WALLET' as any)

        beaconConnected = activeWallet && activeWallet.type === WalletType.P2P
      }
      handler.handle(message, connectionContext, beaconConnected).catch((handlerError: Error) => {
        logger.error('messageHandlerError', handlerError)
      })

      this.listeners.forEach(listener => {
        listener(message, connectionContext)
      })
    }

    this.transport.addListener(transportListener).catch(console.error)
  }

  public async sendToPopup(message: ExtensionMessage<unknown>): Promise<void> {
    return this.popupManager.sendToPopup(message)
  }

  public async sendToBeacon(message: string): Promise<void> {
    logger.log('sending message', message)
    if (this.p2pTransport) {
      const peers: P2PPairInfo[] = await this.p2pTransport.getPeers()
      if (peers.length > 0) {
        this.p2pTransport.send(message).catch((beaconSendError: Error) => {
          logger.error('sendToBeacon', beaconSendError)
        })
      }
    } else {
      throw new Error('p2p not ready')
    }
  }

  public handleMessage: (
    data: ExtensionMessage<ExtensionMessageInputPayload<Action>>,
    connectionContext: ConnectionContext
  ) => Promise<void> = async (
    data: ExtensionMessage<ExtensionMessageInputPayload<Action>>,
    connectionContext: ConnectionContext
  ): Promise<void> => {
    logger.log('handleMessage', data, connectionContext)
    const handler: ActionHandlerFunction<Action> = await new ActionMessageHandler().getHandler(data.payload.action)

    await handler({
      data: data.payload,
      sendResponse: connectionContext.extras ? connectionContext.extras.sendResponse : () => undefined,
      client: this,
      p2pTransport: this.p2pTransport,
      storage: this.storage
    })
  }

  public async addListener(listener: Function): Promise<any> {
    this.listeners.push(listener)
  }

  public async getPermissions(): Promise<PermissionInfo[]> {
    return this.permissionManager.getPermissions()
  }

  public async getPermission(accountIdentifier: string): Promise<PermissionInfo | undefined> {
    return this.permissionManager.getPermission(accountIdentifier)
  }

  public async removePermission(accountIdentifier: string): Promise<void> {
    return this.permissionManager.removePermission(accountIdentifier)
  }

  public async removeAllPermissions(): Promise<void> {
    return this.permissionManager.removeAllPermissions()
  }

  public async getAppMetadataList(): Promise<AppMetadata[]> {
    return this.appMetadataManager.getAppMetadataList()
  }

  public async getAppMetadata(beaconId: string): Promise<AppMetadata | undefined> {
    return this.appMetadataManager.getAppMetadata(beaconId)
  }

  public async removeAppMetadata(beaconId: string): Promise<void> {
    return this.appMetadataManager.removeAppMetadata(beaconId)
  }

  public async removeAllAppMetadata(): Promise<void> {
    return this.appMetadataManager.removeAllAppMetadata()
  }

  public async getWallets(): Promise<WalletInfo[]> {
    logger.log('getWallets')

    return (await this.storage.get('wallets' as any)) || [] // TODO: Fix when wallets type is in sdk
  }

  public async getWallet(publicKey: string): Promise<WalletInfo | undefined> {
    const wallets: WalletInfo[] = (await this.storage.get('wallets' as any)) || [] // TODO: Fix when wallets type is in sdk

    return wallets.find((wallet: WalletInfo) => wallet.publicKey === publicKey)
  }

  public async getWalletByAddress(address: string): Promise<WalletInfo | undefined> {
    const wallets: WalletInfo[] = (await this.storage.get('wallets' as any)) || [] // TODO: Fix when wallets type is in sdk

    return wallets.find((wallet: WalletInfo) => wallet.address === address)
  }

  public async addWallet(walletInfo: WalletInfo): Promise<void> {
    logger.log('addWallet', walletInfo)
    const wallets: WalletInfo[] = (await this.storage.get('wallets' as any)) || [] // TODO: Fix when wallets type is in sdk

    let newWallets: WalletInfo[] = wallets
    if (!wallets.some((wallet: WalletInfo) => wallet.publicKey === walletInfo.publicKey)) {
      if (walletInfo.type === WalletType.LOCAL_MNEMONIC) {
        // There can only be one local mnemonic. So we have to delete the old one if we add a new one
        const filteredWallets: WalletInfo[] = wallets.filter(
          (walletInfoElement: WalletInfo) => walletInfoElement.type !== WalletType.LOCAL_MNEMONIC
        )
        filteredWallets.push(walletInfo)
        newWallets = filteredWallets
      } else {
        newWallets.push(walletInfo)
      }
    }

    return this.storage.set('wallets' as any, newWallets)
  }

  public async removeWallet(publicKey: string): Promise<void> {
    const wallets: WalletInfo[] = (await this.storage.get('wallets' as any)) || [] // TODO: Fix when wallets type is in sdk

    const filteredWallets: WalletInfo[] = wallets.filter((walletInfo: WalletInfo) => walletInfo.publicKey !== publicKey)

    return this.storage.set('wallets' as any, filteredWallets)
  }

  public async removeAllWallets(): Promise<void> {
    return this.storage.delete('wallets' as any)
  }

  /**
   * Process the message before it gets sent to the page.
   *
   * @param data The serialized message that will be sent to the page
   */
  private async processMessage(data: string): Promise<void> {
    const beaconMessage: BeaconMessage = (await new Serializer().deserialize(data)) as BeaconMessage
    if (beaconMessage.type === BeaconMessageType.PermissionResponse) {
      const permissionResponse: PermissionResponse = beaconMessage
      const request:
        | { message: BeaconMessage; connectionContext: ConnectionContext }
        | undefined = this.pendingRequests.find(
        (requestElement: { message: BeaconMessage; connectionContext: ConnectionContext }) =>
          requestElement.message.id === permissionResponse.id
      )
      if (!request) {
        throw new Error('Matching request not found')
      }

      const permissionRequest: PermissionRequest = request.message as PermissionRequest
      const address: string = await getAddressFromPublicKey(permissionResponse.publicKey)
      const permission: PermissionInfo = {
        accountIdentifier: await getAccountIdentifier(address, permissionResponse.network),
        beaconId: permissionResponse.beaconId,
        appMetadata: permissionRequest.appMetadata,
        website: request.connectionContext.id,
        address,
        publicKey: permissionResponse.publicKey,
        network: permissionResponse.network,
        scopes: permissionResponse.scopes,
        connectedAt: new Date().getTime()
      }
      await this.permissionManager.addPermission(permission)
    }
  }

  public async sendToPage(data: string, processMessage: boolean = true): Promise<void> {
    logger.log('sendToPage', 'background.js: post ', data)
    if (processMessage) {
      await this.processMessage(data)
    }
    const message: ExtensionMessage<string> = { target: ExtensionMessageTarget.PAGE, payload: data }
    chrome.tabs.query({}, (tabs: chrome.tabs.Tab[]) => {
      // TODO: Find way to have direct communication with tab
      tabs.forEach(({ id }: chrome.tabs.Tab) => {
        if (id) {
          chrome.tabs.sendMessage(id, message)
        }
      }) // Send message to all tabs
    })
  }
}
