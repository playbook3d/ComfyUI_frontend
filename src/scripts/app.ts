import {
  LGraph,
  LGraphCanvas,
  LGraphEventMode,
  LGraphNode,
  LiteGraph
} from '@comfyorg/litegraph'
import type { Positionable, Vector2 } from '@comfyorg/litegraph'
import type { IBaseWidget } from '@comfyorg/litegraph/dist/types/widgets'
import _ from 'lodash'
import type { ToastMessageOptions } from 'primevue/toast'
import { reactive } from 'vue'

import { useCanvasPositionConversion } from '@/composables/element/useCanvasPositionConversion'
import { useWorkflowValidation } from '@/composables/useWorkflowValidation'
import { st, t } from '@/i18n'
import type {
  ExecutionErrorWsMessage,
  NodeError,
  ResultItem
} from '@/schemas/apiSchema'
import {
  ComfyApiWorkflow,
  type ComfyWorkflowJSON,
  type ModelFile,
  type NodeId
} from '@/schemas/comfyWorkflowSchema'
import {
  type ComfyNodeDef as ComfyNodeDefV1,
  isComboInputSpecV1,
  isComboInputSpecV2
} from '@/schemas/nodeDefSchema'
import { getFromWebmFile } from '@/scripts/metadata/ebml'
import { getGltfBinaryMetadata } from '@/scripts/metadata/gltf'
import { getFromIsobmffFile } from '@/scripts/metadata/isobmff'
import { getMp3Metadata } from '@/scripts/metadata/mp3'
import { getOggMetadata } from '@/scripts/metadata/ogg'
import { getSvgMetadata } from '@/scripts/metadata/svg'
import { useDialogService } from '@/services/dialogService'
import { useExtensionService } from '@/services/extensionService'
import { useLitegraphService } from '@/services/litegraphService'
import { useSubgraphService } from '@/services/subgraphService'
import { useWorkflowService } from '@/services/workflowService'
import { useApiKeyAuthStore } from '@/stores/apiKeyAuthStore'
import { useExecutionStore } from '@/stores/executionStore'
import { useExtensionStore } from '@/stores/extensionStore'
import { useFirebaseAuthStore } from '@/stores/firebaseAuthStore'
import { KeyComboImpl, useKeybindingStore } from '@/stores/keybindingStore'
import { useCommandStore } from '@/stores/commandStore'
import { ComfyWorkflowNodeData } from './playbook-scripts/playbookTypes'
import { useModelStore } from '@/stores/modelStore'
import { SYSTEM_NODE_DEFS, useNodeDefStore } from '@/stores/nodeDefStore'
import { useSettingStore } from '@/stores/settingStore'
import { useToastStore } from '@/stores/toastStore'
import { useWidgetStore } from '@/stores/widgetStore'
import { ComfyWorkflow } from '@/stores/workflowStore'
import { useColorPaletteStore } from '@/stores/workspace/colorPaletteStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { ComfyExtension, MissingNodeType } from '@/types/comfy'
import { ExtensionManager } from '@/types/extensionTypes'
import { ColorAdjustOptions, adjustColor } from '@/utils/colorUtil'
import { graphToPrompt } from '@/utils/executionUtil'
import {
  executeWidgetsCallback,
  fixLinkInputSlots,
  isImageNode
} from '@/utils/litegraphUtil'
import {
  findLegacyRerouteNodes,
  noNativeReroutes
} from '@/utils/migration/migrateReroute'
import { getSelectedModelsMetadata } from '@/utils/modelMetadataUtil'
import { deserialiseAndCreate } from '@/utils/vintageClipboard'

import { type ComfyApi, PromptExecutionError, api } from './api'
import { defaultGraph } from './defaultGraph'
import {
  getFlacMetadata,
  getLatentMetadata,
  getPngMetadata,
  getWebpMetadata,
  importA1111
} from './pnginfo'
import { $el, ComfyUI } from './ui'
import { ComfyAppMenu } from './ui/menu/index'
import { clone } from './utils'
import { type ComfyWidgetConstructor } from './widgets'
import {
  notifyPlaybookWrapperNewWorkflowLoaded,
  notifyWrapperOriginSetOnComfyInstance,
  sendNodeSelectionToPlaybookWrapper,
  sendWorkflowDataToPlaybookWrapper,
} from './playbook-scripts/playbookMessaging'
import { areSelectedItemsEqual, restructureSelectedNodesForPlaybookWrapper } from './playbook-scripts/playbookHelpers'

import { IWidget } from '@comfyorg/litegraph'
import { shallowReactive } from 'vue'
import {
  ComfyWorkflowNodeData,
  WorkflowWindowMessageData
} from './playbook-scripts/playbookTypes'
import { notifyPlaybookWrapperNewWorkflowLoaded } from './playbook-scripts/notifyPlaybookWrapperNewWorkflowLoaded'

export const ANIM_PREVIEW_WIDGET = '$$comfy_animation_preview'

function sanitizeNodeName(string: string) {
  let entityMap = {
    '&': '',
    '<': '',
    '>': '',
    '"': '',
    "'": '',
    '`': '',
    '=': ''
  }
  return String(string).replace(/[&<>"'`=]/g, function fromEntityMap(s) {
    return entityMap[s as keyof typeof entityMap]
  })
}

type Clipspace = {
  widgets?: Pick<IBaseWidget, 'type' | 'name' | 'value'>[] | null
  imgs?: HTMLImageElement[] | null
  original_imgs?: HTMLImageElement[] | null
  images?: any[] | null
  selectedIndex: number
  img_paste_mode: string
}

export class ComfyApp {
  /**
   * List of entries to queue
   */
  #queueItems: {
    number: number
    batchCount: number
    queueNodeIds?: NodeId[]
  }[] = []
  /**
   * If the queue is currently being processed
   */
  #processingQueue: boolean = false

  /**
   * Content Clipboard
   * @type {serialized node object}
   */
  static clipspace: Clipspace | null = null
  static clipspace_invalidate_handler: (() => void) | null = null
  static open_maskeditor: (() => void) | null = null
  static maskeditor_is_opended: (() => void) | null = null
  static clipspace_return_node = null

  vueAppReady: boolean
  api: ComfyApi
  ui: ComfyUI
  // @ts-expect-error fixme ts strict error
  extensionManager: ExtensionManager
  // @ts-expect-error fixme ts strict error
  _nodeOutputs: Record<string, any>
  nodePreviewImages: Record<string, string[]>
  // @ts-expect-error fixme ts strict error
  #graph: LGraph
  get graph() {
    return this.#graph
  }
  // @ts-expect-error fixme ts strict error
  canvas: LGraphCanvas
  dragOverNode: LGraphNode | null = null
  // @ts-expect-error fixme ts strict error
  canvasEl: HTMLCanvasElement

  #configuringGraphLevel: number = 0
  get configuringGraph() {
    return this.#configuringGraphLevel > 0
  }
  // @ts-expect-error fixme ts strict error
  ctx: CanvasRenderingContext2D
  bodyTop: HTMLElement
  bodyLeft: HTMLElement
  bodyRight: HTMLElement
  bodyBottom: HTMLElement
  canvasContainer: HTMLElement
  menu: ComfyAppMenu
  bypassBgColor: string
  // Set by Comfy.Clipspace extension
  openClipspace: () => void = () => {}

  #positionConversion?: {
    clientPosToCanvasPos: (pos: Vector2) => Vector2
    canvasPosToClientPos: (pos: Vector2) => Vector2
  }

  /**
   * The node errors from the previous execution.
   * @deprecated Use useExecutionStore().lastNodeErrors instead
   */
  get lastNodeErrors(): Record<NodeId, NodeError> | null {
    return useExecutionStore().lastNodeErrors
  }

  /**
   * The error from the previous execution.
   * @deprecated Use useExecutionStore().lastExecutionError instead
   */
  get lastExecutionError(): ExecutionErrorWsMessage | null {
    return useExecutionStore().lastExecutionError
  }

  // Playbook Fields
  serializedNodesDefinition: string | null = null
  playbookWrapperOrigin: string | null = null
  lastSelectedItems: Set<Positionable> = new Set()
  // ------------- |

  /**
   * @deprecated Use useExecutionStore().executingNodeId instead
   */
  get runningNodeId(): NodeId | null {
    return useExecutionStore().executingNodeId
  }

  /**
   * @deprecated Use useWorkspaceStore().shiftDown instead
   */
  get shiftDown(): boolean {
    return useWorkspaceStore().shiftDown
  }

  /**
   * @deprecated Use useWidgetStore().widgets instead
   */
  get widgets(): Record<string, ComfyWidgetConstructor> {
    return Object.fromEntries(useWidgetStore().widgets.entries())
  }

  /**
   * @deprecated storageLocation is always 'server' since
   * https://github.com/comfyanonymous/ComfyUI/commit/53c8a99e6c00b5e20425100f6680cd9ea2652218
   */
  get storageLocation() {
    return 'server'
  }

  /**
   * @deprecated storage migration is no longer needed.
   */
  get isNewUserSession() {
    return false
  }

  /**
   * @deprecated Use useExtensionStore().extensions instead
   */
  get extensions(): ComfyExtension[] {
    return useExtensionStore().extensions
  }

  /**
   * The progress on the current executing node, if the node reports any.
   * @deprecated Use useExecutionStore().executingNodeProgress instead
   */
  get progress() {
    return useExecutionStore()._executingNodeProgress
  }

  /**
   * @deprecated Use {@link isImageNode} from @/utils/litegraphUtil instead
   */
  static isImageNode(node: LGraphNode) {
    return isImageNode(node)
  }

  /**
   * Resets the canvas view to the default
   * @deprecated Use {@link useLitegraphService().resetView} instead
   */
  resetView() {
    useLitegraphService().resetView()
  }

  constructor() {
    this.vueAppReady = false
    this.ui = new ComfyUI(this)
    this.api = api
    // Dummy placeholder elements before GraphCanvas is mounted.
    this.bodyTop = $el('div.comfyui-body-top')
    this.bodyLeft = $el('div.comfyui-body-left')
    this.bodyRight = $el('div.comfyui-body-right')
    this.bodyBottom = $el('div.comfyui-body-bottom')
    this.canvasContainer = $el('div.graph-canvas-container')

    this.menu = new ComfyAppMenu(this)
    this.bypassBgColor = '#FF00FF'

    /*
     *  Subscribe listener to receive messaging from iFrame wrapper layer.
     */
    window.addEventListener('message', async (event) => {
      console.log('Comfy Window Received: ', event)

      const eventMessageData: WorkflowWindowMessageData = event.data

      if (eventMessageData.message === 'SendWrapperOriginToComfyWindow') {
        console.log(
          'Comfy Window Received: SendWrapperOriginToComfyWindow',
          event.origin
        )
        this.playbookWrapperOrigin = event.origin
      }

      if (eventMessageData.message === 'SendWorkflowDataToComfyWindow') {
        console.log(
          'Comfy Window Received: SendWorkflowDataToComfyWindow',
          eventMessageData
        )
        this.loadGraphData(eventMessageData.data as ComfyWorkflowJSON)
      }
    })

    /*
     *  enables functionality - I'M NOT SURE THIS ISUSED OR RELEVANT
     */
    console.log('LOADING APP IN WINDOW', this)
    window.__COMFYAPP = this

    /*
     *  Subscribe listener to receive messaging from Playbook wrapper.
     */
    window.addEventListener('message', async (event) => {
      const eventMessageData: WorkflowWindowMessageData = event.data

      switch (eventMessageData.message) {
        case 'SendWrapperOriginToComfyWindow':
          console.log(
            'Comfy Window Received: SendWrapperOriginToComfyWindow',
            event.origin
          )
          this.playbookWrapperOrigin = event.origin
          notifyWrapperOriginSetOnComfyInstance(this.playbookWrapperOrigin)
          break

        case 'SendWorkflowDataToComfyWindow':
          console.log(
            'Comfy Window Received: SendWorkflowDataToComfyWindow',
            eventMessageData
          )
          await this.loadGraphData(
            eventMessageData.data as ComfyWorkflowJSON,
            true
          )

          this.lastSelectedItems = new Set(this.canvas.selectedItems)
          
          // TODO: Consolidate these methods of handling node selection. Better
          // system might be tracking node selection by array of IDs and getting
          // actual node data by cross-referencing with graph data on the front end.
          // This is a hack way of handling node selection changes;
          // necessary because canvas.onSelectionChange was deprecated
          // without replacement functionality in recent ComfyUI updates.
          document.addEventListener('click', () => {
            if (this.playbookWrapperOrigin) {
              if (!areSelectedItemsEqual(this.lastSelectedItems, this.canvas.selectedItems)) {
                const selectedItems = Array.from(this.canvas.selectedItems)
                const selectedNodes = restructureSelectedNodesForPlaybookWrapper(selectedItems)
                sendNodeSelectionToPlaybookWrapper(selectedNodes, this.playbookWrapperOrigin)
                this.lastSelectedItems = new Set(this.canvas.selectedItems)
              }
            }
          })

          api.addEventListener('graphChanged', (evt) => {
            const activeState = evt.detail
            if (this.playbookWrapperOrigin) {

              const selectedItems = Array.from(this.canvas.selectedItems)

              if (selectedItems.length === 0) return
              
              const selectedNodesActiveState = selectedItems.map(item => {
                const matchingNode = activeState.nodes.find(node => node.id === item.id)
                if (matchingNode) {
                  return matchingNode
                }
              })

              const selectedNodes = restructureSelectedNodesForPlaybookWrapper(selectedItems)

              // As is, there is an issue where widget values reverts during cloning.
              const selectedNodesClone = JSON.parse(JSON.stringify(selectedNodes))

              // So we clone and then reset widget_values with active state. 
              selectedNodesClone.forEach((node: ComfyWorkflowNodeData) => {
                const widgetValues = selectedNodesActiveState.find(_node => _node?.id === node.id)?.widgets_values as string[] 
                node.widgets_values = widgetValues
              })

              sendNodeSelectionToPlaybookWrapper(selectedNodesClone, this.playbookWrapperOrigin)
              this.lastSelectedItems = new Set(this.canvas.selectedItems)
            }
          })
          
          // This listener handles deselection via hotkey deletion.
          this.canvas.onNodeDeselected = () => {
            if (this.playbookWrapperOrigin) {
              const selectedItems = Array.from(this.canvas.selectedItems)
              const selectedNodes = restructureSelectedNodesForPlaybookWrapper(selectedItems)
              sendNodeSelectionToPlaybookWrapper(selectedNodes, this.playbookWrapperOrigin)
              this.lastSelectedItems = new Set(this.canvas.selectedItems)
            }
          }
          
          this.loadGraphData(eventMessageData.data as ComfyWorkflowJSON, true)
          // Once graph is loaded, subscribe a selection change listener.
          // This listener will broadcast selection changes to Playbook wrapper.
          this.canvas.onSelectionChange = (nodes) => {
            this.sendNodeSelectionToPlaybookWrapper(nodes)
          }
          break

        case 'RequestWorkflowDataFromComfyWindow':
          console.log(
            'Comfy Window Received: RequestWorkflowDataFromComfyWindow'
          )
          if (this.playbookWrapperOrigin) {
            sendWorkflowDataToPlaybookWrapper(this.playbookWrapperOrigin)
          }
          break

        // Clear graph. This functionality is identical to that triggered
        // when "Clear" is clicked on the ConfyUI menu.
        case 'ClearWorkflowInComfyWindow':
          console.log('Comfy Window Received: ClearWorkflowInComfyWindow')
          this.clean()
          this.graph.clear()
          useLitegraphService().resetView()
          api.dispatchCustomEvent('graphCleared')
          break

        // Export the workflow as JSON. This functionality is identical to that
        // triggered when "Save" is clicked on the ConfyUI menu.
        case 'ExportWorkflowJSONFromComfyWindow':
          console.log(
            'Comfy Window Received: ExportWorkflowJSONFromComfyWindow'
          )
          useCommandStore().execute('Comfy.ExportWorkflow')
          break

        case 'SendNodesDefinitionToComfyWindow':
          console.log(
            'Comfy Window Received: SendNodesDefinitionToComfyWindow',
            eventMessageData
          )
          this.serializedNodesDefinition = eventMessageData.data
          await this.registerNodes()
          break

        default:
          break
      }
    })

    window.__COMFYAPP = this

    /**
     * Stores the execution output data for each node
     * @type {Record<string, any>}
     */
    this.nodeOutputs = {}

    /**
     * Stores the preview image data for each node
     * @type {Record<string, Image>}
     */
    this.nodePreviewImages = {}
  }

  get nodeOutputs() {
    return this._nodeOutputs
  }

  set nodeOutputs(value) {
    this._nodeOutputs = value
    if (this.vueAppReady)
      useExtensionService().invokeExtensions('onNodeOutputsUpdated', value)
  }

  /**
   * If the user has specified a preferred format to receive preview images in,
   * this function will return that format as a url query param.
   * If the node's outputs are not images, this param should not be used, as it will
   * force the server to load the output file as an image.
   */
  getPreviewFormatParam() {
    let preview_format = useSettingStore().get('Comfy.PreviewFormat')
    if (preview_format) return `&preview=${preview_format}`
    else return ''
  }

  getRandParam() {
    return '&rand=' + Math.random()
  }

  static onClipspaceEditorSave() {
    if (ComfyApp.clipspace_return_node) {
      ComfyApp.pasteFromClipspace(ComfyApp.clipspace_return_node)
    }
  }

  static onClipspaceEditorClosed() {
    ComfyApp.clipspace_return_node = null
  }

  static copyToClipspace(node: LGraphNode) {
    var widgets = null
    if (node.widgets) {
      widgets = node.widgets.map(({ type, name, value }) => ({
        type,
        name,
        value
      }))
    }

    var imgs = undefined
    var orig_imgs = undefined
    if (node.imgs != undefined) {
      imgs = []
      orig_imgs = []

      for (let i = 0; i < node.imgs.length; i++) {
        imgs[i] = new Image()
        imgs[i].src = node.imgs[i].src
        orig_imgs[i] = imgs[i]
      }
    }

    var selectedIndex = 0
    if (node.imageIndex) {
      selectedIndex = node.imageIndex
    }

    ComfyApp.clipspace = {
      widgets: widgets,
      imgs: imgs,
      original_imgs: orig_imgs,
      images: node.images,
      selectedIndex: selectedIndex,
      img_paste_mode: 'selected' // reset to default im_paste_mode state on copy action
    }

    ComfyApp.clipspace_return_node = null

    if (ComfyApp.clipspace_invalidate_handler) {
      ComfyApp.clipspace_invalidate_handler()
    }
  }

  static pasteFromClipspace(node: LGraphNode) {
    if (ComfyApp.clipspace) {
      // image paste
      if (ComfyApp.clipspace.imgs && node.imgs) {
        if (node.images && ComfyApp.clipspace.images) {
          if (ComfyApp.clipspace['img_paste_mode'] == 'selected') {
            node.images = [
              ComfyApp.clipspace.images[ComfyApp.clipspace['selectedIndex']]
            ]
          } else {
            node.images = ComfyApp.clipspace.images
          }

          if (app.nodeOutputs[node.id + ''])
            app.nodeOutputs[node.id + ''].images = node.images
        }

        if (ComfyApp.clipspace.imgs) {
          // deep-copy to cut link with clipspace
          if (ComfyApp.clipspace['img_paste_mode'] == 'selected') {
            const img = new Image()
            img.src =
              ComfyApp.clipspace.imgs[ComfyApp.clipspace['selectedIndex']].src
            node.imgs = [img]
            node.imageIndex = 0
          } else {
            const imgs = []
            for (let i = 0; i < ComfyApp.clipspace.imgs.length; i++) {
              imgs[i] = new Image()
              imgs[i].src = ComfyApp.clipspace.imgs[i].src
              node.imgs = imgs
            }
          }
        }
      }

      if (node.widgets) {
        if (ComfyApp.clipspace.images) {
          const clip_image =
            ComfyApp.clipspace.images[ComfyApp.clipspace['selectedIndex']]
          const index = node.widgets.findIndex((obj) => obj.name === 'image')
          if (index >= 0) {
            if (
              node.widgets[index].type != 'image' &&
              typeof node.widgets[index].value == 'string' &&
              clip_image.filename
            ) {
              node.widgets[index].value =
                (clip_image.subfolder ? clip_image.subfolder + '/' : '') +
                clip_image.filename +
                (clip_image.type ? ` [${clip_image.type}]` : '')
            } else {
              node.widgets[index].value = clip_image
            }
          }
        }
        if (ComfyApp.clipspace.widgets) {
          ComfyApp.clipspace.widgets.forEach(({ type, name, value }) => {
            // @ts-expect-error fixme ts strict error
            const prop = Object.values(node.widgets).find(
              (obj) => obj.type === type && obj.name === name
            )
            if (prop && prop.type != 'button') {
              if (
                prop.type != 'image' &&
                typeof prop.value == 'string' &&
                // @ts-expect-error Custom widget value
                value.filename
              ) {
                const resultItem = value as ResultItem
                prop.value =
                  (resultItem.subfolder ? resultItem.subfolder + '/' : '') +
                  resultItem.filename +
                  (resultItem.type ? ` [${resultItem.type}]` : '')
              } else {
                prop.value = value
                prop.callback?.(value)
              }
            }
          })
        }
      }

      app.graph.setDirtyCanvas(true)
    }
  }

  get enabledExtensions() {
    if (!this.vueAppReady) {
      return this.extensions
    }
    return useExtensionStore().enabledExtensions
  }

  /**
   * Send message with workflow data to wrapping iFrame layer.
   */
  public async sendWorkflowDataToPlaybookWrapper() {
    // const wrapperOrigin = import.meta.env.VITE_CONNECT_TO
    const graphData = await this.graphToPrompt()

    const messageData: WorkflowWindowMessageData = {
      message: 'SendWorkflowDataToPlaybookWrapper',
      data: graphData.workflow
    }

    console.log(
      'Comfy Window Sending: SendWorkflowDataToPlaybookWrapper: ',
      messageData
    )

    window.top.postMessage(messageData, this.playbookWrapperOrigin)
  }

  /**
   * Send message with workflow data to wrapping iFrame layer.
   */
  async notifyPlaybookWrapperGraphInitialized() {
    console.log('Comfy Window Sending: ComfyWindowInitialized')

    // const wrapperOrigin = import.meta.env.VITE_CONNECT_TO
    console.log(
      'Comfy Window Sending: WrapperOriginSetOnComfyInstance: target origin: ',
      this.playbookWrapperOrigin
    )

    const messageData: WorkflowWindowMessageData = {
      message: 'WrapperOriginSetOnComfyInstance'
    }

    window.top.postMessage(messageData, this.playbookWrapperOrigin)
  }

  /**
   * Send message with selected nodes data to Playbook wrapper.
   */
  async sendNodeSelectionToPlaybookWrapper(selectedNodes) {
    console.log(
      'Comfy Window Sending: sendNodeSelectionToPlaybookWrapper: target origin: ',
      selectedNodes
    )

    const selectedNodesArray = Object.values(selectedNodes)

    // Reduce node data to structure expected by Playbook wrapper.
    const restructuredNodesData = selectedNodesArray.map((node: any) => {
      const nodeData: ComfyWorkflowNodeData = {
        id: node.id,
        type: node.type,
        widgets_values: node.widgets_values,
        widgets: node.widgets,
        title: node.title,
        inputs: node.inputs,
        outputs: node.outputs,
        properties: node.properties,
        pos: node.pos,
        size: node.size,
        flags: node.flags
      }

      return nodeData
    })

    // Serializing data to prevent errors messaging objects with callbacks.
    const messageData: WorkflowWindowMessageData = {
      message: 'SendSelectedNodesToPlaybookWrapper',
      data: JSON.stringify(restructuredNodesData)
    }

    window.top.postMessage(messageData, this.playbookWrapperOrigin)
  }

  /**
   * Invoke an extension callback
   * @param {keyof ComfyExtension} method The extension callback to execute
   * @param  {any[]} args Any arguments to pass to the callback
   * @returns
   */
  #invokeExtensions(method, ...args) {
    let results = []
    for (const ext of this.enabledExtensions) {
      if (method in ext) {
        try {
          results.push(ext[method](...args, this))
        } catch (error) {
          console.error(
            `Error calling extension '${ext.name}' method '${method}'`,
            { error },
            { extension: ext },
            { args }
          )
        }
      }
    }
    return results
  }

  /**
   * Invoke an async extension callback
   * Each callback will be invoked concurrently
   * @param {string} method The extension callback to execute
   * @param  {...any} args Any arguments to pass to the callback
   * @returns
   */
  async #invokeExtensionsAsync(method, ...args) {
    return await Promise.all(
      this.enabledExtensions.map(async (ext) => {
        if (method in ext) {
          try {
            return await ext[method](...args, this)
          } catch (error) {
            console.error(
              `Error calling extension '${ext.name}' method '${method}'`,
              { error },
              { extension: ext },
              { args }
            )
          }
        }
      })
    )
  }

  #addRestoreWorkflowView() {
    const serialize = LGraph.prototype.serialize
    const self = this
    LGraph.prototype.serialize = function () {
      const workflow = serialize.apply(this, arguments)

      // Store the drag & scale info in the serialized workflow if the setting is enabled
      if (self.enableWorkflowViewRestore.value) {
        if (!workflow.extra) {
          workflow.extra = {}
        }
        workflow.extra.ds = {
          scale: self.canvas.ds.scale,
          offset: self.canvas.ds.offset
        }
      } else if (workflow.extra?.ds) {
        // Clear any old view data
        delete workflow.extra.ds
      }

      return workflow
    }
    this.enableWorkflowViewRestore = this.ui.settings.addSetting({
      id: 'Comfy.EnableWorkflowViewRestore',
      category: ['Comfy', 'Workflow', 'EnableWorkflowViewRestore'],
      name: 'Save and restore canvas position and zoom level in workflows',
      type: 'boolean',
      defaultValue: true
    })
  }

  /**
   * Adds special context menu handling for nodes
   * e.g. this adds Open Image functionality for nodes that show images
   * @param {*} node The node to add the menu handler
   */
  #addNodeContextMenuHandler(node) {
    function getCopyImageOption(img) {
      if (typeof window.ClipboardItem === 'undefined') return []
      return [
        {
          content: 'Copy Image',
          callback: async () => {
            const url = new URL(img.src)
            url.searchParams.delete('preview')

            const writeImage = async (blob) => {
              await navigator.clipboard.write([
                new ClipboardItem({
                  [blob.type]: blob
                })
              ])
            }

            try {
              const data = await fetch(url)
              const blob = await data.blob()
              try {
                await writeImage(blob)
              } catch (error) {
                // Chrome seems to only support PNG on write, convert and try again
                if (blob.type !== 'image/png') {
                  const canvas = $el('canvas', {
                    width: img.naturalWidth,
                    height: img.naturalHeight
                  }) as HTMLCanvasElement
                  const ctx = canvas.getContext('2d')
                  let image
                  if (typeof window.createImageBitmap === 'undefined') {
                    image = new Image()
                    const p = new Promise((resolve, reject) => {
                      image.onload = resolve
                      image.onerror = reject
                    }).finally(() => {
                      URL.revokeObjectURL(image.src)
                    })
                    image.src = URL.createObjectURL(blob)
                    await p
                  } else {
                    image = await createImageBitmap(blob)
                  }
                  try {
                    ctx.drawImage(image, 0, 0)
                    canvas.toBlob(writeImage, 'image/png')
                  } finally {
                    if (typeof image.close === 'function') {
                      image.close()
                    }
                  }

                  return
                }
                throw error
              }
            } catch (error) {
              useToastStore().addAlert(
                'Error copying image: ' + (error.message ?? error)
              )
            }
          }
        }
      ]
    }

    node.prototype.getExtraMenuOptions = function (_, options) {
      if (this.imgs) {
        // If this node has images then we add an open in new tab item
        let img
        if (this.imageIndex != null) {
          // An image is selected so select that
          img = this.imgs[this.imageIndex]
        } else if (this.overIndex != null) {
          // No image is selected but one is hovered
          img = this.imgs[this.overIndex]
        }
        if (img) {
          options.unshift(
            {
              content: 'Open Image',
              callback: () => {
                let url = new URL(img.src)
                url.searchParams.delete('preview')
                window.open(url, '_blank')
              }
            },
            ...getCopyImageOption(img),
            {
              content: 'Save Image',
              callback: () => {
                const a = document.createElement('a')
                let url = new URL(img.src)
                url.searchParams.delete('preview')
                a.href = url.toString()
                a.setAttribute(
                  'download',
                  new URLSearchParams(url.search).get('filename')
                )
                document.body.append(a)
                a.click()
                requestAnimationFrame(() => a.remove())
              }
            }
          )
        }
      }

      options.push({
        content: 'Bypass',
        callback: (obj) => {
          if (this.mode === 4) this.mode = 0
          else this.mode = 4
          this.graph.change()
        }
      })

      // prevent conflict of clipspace content
      if (!ComfyApp.clipspace_return_node) {
        options.push({
          content: 'Copy (Clipspace)',
          callback: (obj) => {
            ComfyApp.copyToClipspace(this)
          }
        })

        if (ComfyApp.clipspace != null) {
          options.push({
            content: 'Paste (Clipspace)',
            callback: () => {
              ComfyApp.pasteFromClipspace(this)
            }
          })
        }

        if (ComfyApp.isImageNode(this)) {
          options.push({
            content: 'Open in MaskEditor',
            callback: (obj) => {
              ComfyApp.copyToClipspace(this)
              ComfyApp.clipspace_return_node = this
              ComfyApp.open_maskeditor()
            }
          })
        }
      }
    }
  }

  #addNodeKeyHandler(node) {
    const app = this
    const origNodeOnKeyDown = node.prototype.onKeyDown

    node.prototype.onKeyDown = function (e) {
      if (origNodeOnKeyDown && origNodeOnKeyDown.apply(this, e) === false) {
        return false
      }

      if (this.flags.collapsed || !this.imgs || this.imageIndex === null) {
        return
      }

      let handled = false

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.key === 'ArrowLeft') {
          this.imageIndex -= 1
        } else if (e.key === 'ArrowRight') {
          this.imageIndex += 1
        }
        this.imageIndex %= this.imgs.length

        if (this.imageIndex < 0) {
          this.imageIndex = this.imgs.length + this.imageIndex
        }
        handled = true
      } else if (e.key === 'Escape') {
        this.imageIndex = null
        handled = true
      }

      if (handled === true) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return false
      }
    }
  }

  /**
   * Adds Custom drawing logic for nodes
   * e.g. Draws images and handles thumbnail navigation on nodes that output images
   * @param {*} node The node to add the draw handler
   */
  #addDrawBackgroundHandler(node) {
    const app = this

    function getImageTop(node) {
      let shiftY
      if (node.imageOffset != null) {
        shiftY = node.imageOffset
      } else {
        if (node.widgets?.length) {
          const w = node.widgets[node.widgets.length - 1]
          shiftY = w.last_y
          if (w.computeSize) {
            shiftY += w.computeSize()[1] + 4
          } else if (w.computedHeight) {
            shiftY += w.computedHeight
          } else {
            shiftY += LiteGraph.NODE_WIDGET_HEIGHT + 4
          }
        } else {
          shiftY = node.computeSize()[1]
        }
      }
      return shiftY
    }

    node.prototype.setSizeForImage = function (force) {
      if (!force && this.animatedImages) return

      if (this.inputHeight || this.freeWidgetSpace > 210) {
        this.setSize(this.size)
        return
      }
      const minHeight = getImageTop(this) + 220
      if (this.size[1] < minHeight) {
        this.setSize([this.size[0], minHeight])
      }
    }

    function unsafeDrawBackground(ctx) {
      if (!this.flags.collapsed) {
        let imgURLs = []
        let imagesChanged = false

        const output = app.nodeOutputs[this.id + '']
        if (output?.images) {
          this.animatedImages = output?.animated?.find(Boolean)
          if (this.images !== output.images) {
            this.images = output.images
            imagesChanged = true
            imgURLs = imgURLs.concat(
              output.images.map((params) => {
                return api.apiURL(
                  '/view?' +
                    new URLSearchParams(params).toString() +
                    (this.animatedImages ? '' : app.getPreviewFormatParam()) +
                    app.getRandParam()
                )
              })
            )
          }
        }

        const preview = app.nodePreviewImages[this.id + '']
        if (this.preview !== preview) {
          this.preview = preview
          imagesChanged = true
          if (preview != null) {
            imgURLs.push(preview)
          }
        }

        if (imagesChanged) {
          this.imageIndex = null
          if (imgURLs.length > 0) {
            Promise.all(
              imgURLs.map((src) => {
                return new Promise((r) => {
                  const img = new Image()
                  img.onload = () => r(img)
                  img.onerror = () => r(null)
                  img.src = src
                })
              })
            ).then((imgs) => {
              if (
                (!output || this.images === output.images) &&
                (!preview || this.preview === preview)
              ) {
                this.imgs = imgs.filter(Boolean)
                this.setSizeForImage?.()
                app.graph.setDirtyCanvas(true)
              }
            })
          } else {
            this.imgs = null
          }
        }

        const is_all_same_aspect_ratio = (imgs) => {
          // assume: imgs.length >= 2
          let ratio = imgs[0].naturalWidth / imgs[0].naturalHeight

          for (let i = 1; i < imgs.length; i++) {
            let this_ratio = imgs[i].naturalWidth / imgs[i].naturalHeight
            if (ratio != this_ratio) return false
          }

          return true
        }

        if (this.imgs?.length) {
          const widgetIdx = this.widgets?.findIndex(
            (w) => w.name === ANIM_PREVIEW_WIDGET
          )

          if (this.animatedImages) {
            // Instead of using the canvas we'll use a IMG
            if (widgetIdx > -1) {
              // Replace content
              const widget = this.widgets[widgetIdx]
              widget.options.host.updateImages(this.imgs)
            } else {
              const host = createImageHost(this)
              this.setSizeForImage(true)
              const widget = this.addDOMWidget(
                ANIM_PREVIEW_WIDGET,
                'img',
                host.el,
                {
                  host,
                  getHeight: host.getHeight,
                  onDraw: host.onDraw,
                  hideOnZoom: false
                }
              )
              widget.serializeValue = () => undefined
              widget.options.host.updateImages(this.imgs)
            }
            return
          }

          if (widgetIdx > -1) {
            this.widgets[widgetIdx].onRemove?.()
            this.widgets.splice(widgetIdx, 1)
          }

          const canvas = app.graph.list_of_graphcanvas[0]
          const mouse = canvas.graph_mouse
          if (!canvas.pointer_is_down && this.pointerDown) {
            if (
              mouse[0] === this.pointerDown.pos[0] &&
              mouse[1] === this.pointerDown.pos[1]
            ) {
              this.imageIndex = this.pointerDown.index
            }
            this.pointerDown = null
          }

          let imageIndex = this.imageIndex
          const numImages = this.imgs.length
          if (numImages === 1 && !imageIndex) {
            this.imageIndex = imageIndex = 0
          }

          const top = getImageTop(this)
          var shiftY = top

          let dw = this.size[0]
          let dh = this.size[1]
          dh -= shiftY

          if (imageIndex == null) {
            var cellWidth, cellHeight, shiftX, cell_padding, cols

            const compact_mode = is_all_same_aspect_ratio(this.imgs)
            if (!compact_mode) {
              // use rectangle cell style and border line
              cell_padding = 2
              // Prevent infinite canvas2d scale-up
              const largestDimension = this.imgs.reduce(
                (acc, current) =>
                  Math.max(acc, current.naturalWidth, current.naturalHeight),
                0
              )
              const fakeImgs = []
              fakeImgs.length = this.imgs.length
              fakeImgs[0] = {
                naturalWidth: largestDimension,
                naturalHeight: largestDimension
              }
              ;({ cellWidth, cellHeight, cols, shiftX } = calculateImageGrid(
                fakeImgs,
                dw,
                dh
              ))
            } else {
              cell_padding = 0
              ;({ cellWidth, cellHeight, cols, shiftX } = calculateImageGrid(
                this.imgs,
                dw,
                dh
              ))
            }

            let anyHovered = false
            this.imageRects = []
            for (let i = 0; i < numImages; i++) {
              const img = this.imgs[i]
              const row = Math.floor(i / cols)
              const col = i % cols
              const x = col * cellWidth + shiftX
              const y = row * cellHeight + shiftY
              if (!anyHovered) {
                anyHovered = LiteGraph.isInsideRectangle(
                  mouse[0],
                  mouse[1],
                  x + this.pos[0],
                  y + this.pos[1],
                  cellWidth,
                  cellHeight
                )
                if (anyHovered) {
                  this.overIndex = i
                  let value = 110
                  if (canvas.pointer_is_down) {
                    if (!this.pointerDown || this.pointerDown.index !== i) {
                      this.pointerDown = { index: i, pos: [...mouse] }
                    }
                    value = 125
                  }
                  ctx.filter = `contrast(${value}%) brightness(${value}%)`
                  canvas.canvas.style.cursor = 'pointer'
                }
              }
              this.imageRects.push([x, y, cellWidth, cellHeight])

              let wratio = cellWidth / img.width
              let hratio = cellHeight / img.height
              var ratio = Math.min(wratio, hratio)

              let imgHeight = ratio * img.height
              let imgY =
                row * cellHeight + shiftY + (cellHeight - imgHeight) / 2
              let imgWidth = ratio * img.width
              let imgX = col * cellWidth + shiftX + (cellWidth - imgWidth) / 2

              ctx.drawImage(
                img,
                imgX + cell_padding,
                imgY + cell_padding,
                imgWidth - cell_padding * 2,
                imgHeight - cell_padding * 2
              )
              if (!compact_mode) {
                // rectangle cell and border line style
                ctx.strokeStyle = '#8F8F8F'
                ctx.lineWidth = 1
                ctx.strokeRect(
                  x + cell_padding,
                  y + cell_padding,
                  cellWidth - cell_padding * 2,
                  cellHeight - cell_padding * 2
                )
              }

              ctx.filter = 'none'
            }

            if (!anyHovered) {
              this.pointerDown = null
              this.overIndex = null
            }
          } else {
            // Draw individual
            let w = this.imgs[imageIndex].naturalWidth
            let h = this.imgs[imageIndex].naturalHeight

            const scaleX = dw / w
            const scaleY = dh / h
            const scale = Math.min(scaleX, scaleY, 1)

            w *= scale
            h *= scale

            let x = (dw - w) / 2
            let y = (dh - h) / 2 + shiftY
            ctx.drawImage(this.imgs[imageIndex], x, y, w, h)

            const drawButton = (x, y, sz, text) => {
              const hovered = LiteGraph.isInsideRectangle(
                mouse[0],
                mouse[1],
                x + this.pos[0],
                y + this.pos[1],
                sz,
                sz
              )
              let fill = '#333'
              let textFill = '#fff'
              let isClicking = false
              if (hovered) {
                canvas.canvas.style.cursor = 'pointer'
                if (canvas.pointer_is_down) {
                  fill = '#1e90ff'
                  isClicking = true
                } else {
                  fill = '#eee'
                  textFill = '#000'
                }
              } else {
                this.pointerWasDown = null
              }

              ctx.fillStyle = fill
              ctx.beginPath()
              ctx.roundRect(x, y, sz, sz, [4])
              ctx.fill()
              ctx.fillStyle = textFill
              ctx.font = '12px Arial'
              ctx.textAlign = 'center'
              ctx.fillText(text, x + 15, y + 20)

              return isClicking
            }

            if (numImages > 1) {
              if (
                drawButton(
                  dw - 40,
                  dh + top - 40,
                  30,
                  `${this.imageIndex + 1}/${numImages}`
                )
              ) {
                let i =
                  this.imageIndex + 1 >= numImages ? 0 : this.imageIndex + 1
                if (!this.pointerDown || !this.pointerDown.index === i) {
                  this.pointerDown = { index: i, pos: [...mouse] }
                }
              }

              if (drawButton(dw - 40, top + 10, 30, `x`)) {
                if (!this.pointerDown || !this.pointerDown.index === null) {
                  this.pointerDown = { index: null, pos: [...mouse] }
                }
              }
            }
          }
        }
      }
    }

    node.prototype.onDrawBackground = function (ctx) {
      try {
        unsafeDrawBackground.call(this, ctx)
      } catch (error) {
        console.error('Error drawing node background', error)
      }
    }
  }

  /**
   * Adds a handler allowing drag+drop of files onto the window to load workflows
   */
  #addDropHandler() {
    // Get prompt from dropped PNG or json
    document.addEventListener('drop', async (event) => {
      try {
        event.preventDefault()
        event.stopPropagation()

        const n = this.dragOverNode
        this.dragOverNode = null
        // Node handles file drop, we dont use the built in onDropFile handler as its buggy
        // If you drag multiple files it will call it multiple times with the same file
        if (n && n.onDragDrop && (await n.onDragDrop(event))) {
          return
        }
        // Dragging from Chrome->Firefox there is a file but its a bmp, so ignore that
        if (!event.dataTransfer) return
        if (
          event.dataTransfer.files.length &&
          event.dataTransfer.files[0].type !== 'image/bmp'
        ) {
          await this.handleFile(event.dataTransfer.files[0])
        } else {
          // Try loading the first URI in the transfer list
          const validTypes = ['text/uri-list', 'text/x-moz-url']
          const match = [...event.dataTransfer.types].find((t) =>
            validTypes.find((v) => t === v)
          )
          if (match) {
            const uri = event.dataTransfer.getData(match)?.split('\n')?.[0]
            if (uri) {
              const blob = await (await fetch(uri)).blob()
              await this.handleFile(new File([blob], uri, { type: blob.type }))
            }
          }
        }
      } catch (err: any) {
        useToastStore().addAlert(
          t('toastMessages.dropFileError', { error: err })
        )
      }
    })

    // Always clear over node on drag leave
    this.canvasEl.addEventListener('dragleave', async () => {
      if (this.dragOverNode) {
        this.dragOverNode = null
        this.graph.setDirtyCanvas(false, true)
      }
    })

    // Add handler for dropping onto a specific node
    this.canvasEl.addEventListener(
      'dragover',
      (e) => {
        // Disable dropEffect (green plus icon) for JSON files.
        const items = e.dataTransfer.items
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (
              items[i].kind === 'file' &&
              items[i].type === 'application/json'
            ) {
              console.log(`File type: ${items[i].type}`)
              e.dataTransfer.dropEffect = 'none'
            }
          }
        }

        this.canvas.adjustMouseEvent(e)
        const node = this.graph.getNodeOnPos(e.canvasX, e.canvasY)
        if (node) {
          if (node.onDragOver && node.onDragOver(e)) {
            this.dragOverNode = node

            // dragover event is fired very frequently, run this on an animation frame
            requestAnimationFrame(() => {
              this.graph.setDirtyCanvas(false, true)
            })
            return
          }
        }
        this.dragOverNode = null
      },
      false
    )
  }

  /**
   * Handle keypress
   */
  #addProcessKeyHandler() {
    const origProcessKey = LGraphCanvas.prototype.processKey
    LGraphCanvas.prototype.processKey = function (e: KeyboardEvent) {
      if (!this.graph) return

      if (e.target instanceof Element && e.target.localName == 'input') {
        return
      }

      if (e.type == 'keydown' && !e.repeat) {
        const keyCombo = KeyComboImpl.fromEvent(e)
        const keybindingStore = useKeybindingStore()
        const keybinding = keybindingStore.getKeybinding(keyCombo)

        if (keybinding && keybinding.targetElementId === 'graph-canvas') {
          useCommandStore().execute(keybinding.commandId)

          this.graph.change()
          e.preventDefault()
          e.stopImmediatePropagation()
          return
        }

        // Ctrl+C Copy
        if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
          return
        }

        // Ctrl+V Paste
        if (
          (e.key === 'v' || e.key == 'V') &&
          (e.metaKey || e.ctrlKey) &&
          !e.shiftKey
        ) {
          return
        }
      }

      // Fall through to Litegraph defaults
      // @ts-expect-error fixme ts strict error
      return origProcessKey.apply(this, arguments)
    }
  }

  #addDrawNodeHandler() {
    const origDrawNode = LGraphCanvas.prototype.drawNode
    LGraphCanvas.prototype.drawNode = function (node) {
      const editor_alpha = this.editor_alpha
      const old_color = node.color
      const old_bgcolor = node.bgcolor

      if (node.mode === LGraphEventMode.NEVER) {
        this.editor_alpha = 0.4
      }

      let bgColor: string
      if (node.mode === LGraphEventMode.BYPASS) {
        bgColor = app.bypassBgColor
        this.editor_alpha = 0.2
      } else {
        bgColor = old_bgcolor || LiteGraph.NODE_DEFAULT_BGCOLOR
      }

      const adjustments: ColorAdjustOptions = {}

      const opacity = useSettingStore().get('Comfy.Node.Opacity')
      if (opacity) adjustments.opacity = opacity

      if (useColorPaletteStore().completedActivePalette.light_theme) {
        adjustments.lightness = 0.5

        // Lighten title bar of colored nodes on light theme
        if (old_color) {
          node.color = adjustColor(old_color, { lightness: 0.5 })
        }
      }

      node.bgcolor = adjustColor(bgColor, adjustments)

      // @ts-expect-error fixme ts strict error
      const res = origDrawNode.apply(this, arguments)

      this.editor_alpha = editor_alpha
      node.color = old_color
      node.bgcolor = old_bgcolor

      return res
    }
  }

  /**
   * Handles updates from the API socket
   */
  #addApiUpdateHandlers() {
    api.addEventListener('status', ({ detail }) => {
      this.ui.setStatus(detail)
    })

    api.addEventListener('progress', () => {
      this.graph.setDirtyCanvas(true, false)
    })

    api.addEventListener('executing', () => {
      const executionStore = useExecutionStore()
      this.graph.setDirtyCanvas(true, false)
      // @ts-expect-error fixme ts strict error
      this.revokePreviews(executionStore.executingNodeId)

      // @ts-expect-error fixme ts strict error
      delete this.nodePreviewImages[executionStore.executingNodeId]
    })

    api.addEventListener('executed', ({ detail }) => {
      const output = this.nodeOutputs[detail.display_node || detail.node]
      if (detail.merge && output) {
        for (const k in detail.output ?? {}) {
          const v = output[k]
          if (v instanceof Array) {
            output[k] = v.concat(detail.output[k])
          } else {
            output[k] = detail.output[k]
          }
        }
      } else {
        this.nodeOutputs[detail.display_node || detail.node] = detail.output
      }
      const node = this.graph.getNodeById(detail.display_node || detail.node)
      if (node) {
        if (node.onExecuted) node.onExecuted(detail.output)
      }
    })

    api.addEventListener('execution_start', () => {
      this.graph.nodes.forEach((node) => {
        if (node.onExecutionStart) node.onExecutionStart()
      })
    })

    api.addEventListener('execution_error', ({ detail }) => {
      // Check if this is an auth-related error or credits-related error
      if (
        detail.exception_message?.includes(
          'Unauthorized: Please login first to use this node.'
        )
      ) {
        useDialogService().showApiNodesSignInDialog([detail.node_type])
      } else if (
        detail.exception_message?.includes(
          'Payment Required: Please add credits to your account to use this node.'
        )
      ) {
        useDialogService().showTopUpCreditsDialog({
          isInsufficientCredits: true
        })
      } else {
        useDialogService().showExecutionErrorDialog(detail)
      }
      this.canvas.draw(true, true)
    })

    api.addEventListener('b_preview', ({ detail }) => {
      const id = this.runningNodeId
      if (id == null) return

      const blob = detail
      const blobUrl = URL.createObjectURL(blob)
      // Ensure clean up if `executing` event is missed.
      this.revokePreviews(id)
      this.nodePreviewImages[id] = [blobUrl]
    })

    api.init()
  }

  /** Flag that the graph is configuring to prevent nodes from running checks while its still loading */
  #addConfigureHandler() {
    const app = this
    const configure = LGraph.prototype.configure
    LGraph.prototype.configure = function (...args) {
      app.#configuringGraphLevel++
      try {
        return configure.apply(this, args)
      } finally {
        app.#configuringGraphLevel--
      }
    }
  }

  #addAfterConfigureHandler() {
    const { graph } = this
    const { onConfigure } = graph
    graph.onConfigure = function (...args) {
      fixLinkInputSlots(this)

      // Fire callbacks before the onConfigure, this is used by widget inputs to setup the config
      for (const node of graph.nodes) {
        node.onGraphConfigured?.()
      }

      const r = onConfigure?.apply(this, args)

      // Fire after onConfigure, used by primitives to generate widget using input nodes config
      for (const node of graph.nodes) {
        node.onAfterGraphConfigured?.()
      }

      return r
    }
  }

  /**
   * Set up the app on the page
   */
  async setup(canvasEl: HTMLCanvasElement) {
    // [Playbook Edit]
    // //@ts-expect-error fixme ts strict error
    // this.bodyTop = document.getElementById('comfyui-body-top')
    // //@ts-expect-error fixme ts strict error
    // this.bodyLeft = document.getElementById('comfyui-body-left')
    // //@ts-expect-error fixme ts strict error
    // this.bodyRight = document.getElementById('comfyui-body-right')
    // //@ts-expect-error fixme ts strict error
    // this.bodyBottom = document.getElementById('comfyui-body-bottom')
    // @ts-expect-error fixme ts strict error
    this.canvasContainer = document.getElementById('graph-canvas-container')

    this.canvasEl = canvasEl
    this.resizeCanvas()

    await useWorkspaceStore().workflow.syncWorkflows()
    await useExtensionService().loadExtensions()

    this.#addProcessKeyHandler()
    this.#addConfigureHandler()
    this.#addApiUpdateHandlers()

    if (!this.graph) {
      this.#graph = new LGraph()

      console.log('ComfyUI: new LGraph created in setup')
    }

    // Register the subgraph - adds type wrapper for Litegraph's `createNode` factory
    this.graph.events.addEventListener('subgraph-created', (e) => {
      try {
        const { subgraph, data } = e.detail
        useSubgraphService().registerNewSubgraph(subgraph, data)
      } catch (err) {
        console.error('Failed to register subgraph', err)
        useToastStore().add({
          severity: 'error',
          summary: 'Failed to register subgraph',
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    })


    this.#addAfterConfigureHandler()

    this.canvas = new LGraphCanvas(canvasEl, this.graph)
    // Make canvas states reactive so we can observe changes on them.
    this.canvas.state = reactive(this.canvas.state)

    // @ts-expect-error fixme ts strict error
    this.ctx = canvasEl.getContext('2d')

    LiteGraph.alt_drag_do_clone_nodes = true
    LiteGraph.macGesturesRequireMac = false

    this.canvas.canvas.addEventListener<'litegraph:set-graph'>(
      'litegraph:set-graph',
      (e) => {
        // Assertion: Not yet defined in litegraph.
        const { newGraph } = e.detail

        const nodeSet = new Set(newGraph.nodes)
        const widgetStore = useDomWidgetStore()

        // Assertions: UnwrapRef
        for (const { widget } of widgetStore.activeWidgetStates) {
          if (!nodeSet.has(widget.node)) {
            widgetStore.deactivateWidget(widget.id)
          }
        }

        for (const { widget } of widgetStore.inactiveWidgetStates) {
          if (nodeSet.has(widget.node)) {
            widgetStore.activateWidget(widget.id)
          }
        }
      }
    )

    this.graph.start()

    // Ensure the canvas fills the window
    this.resizeCanvas()
    window.addEventListener('resize', () => this.resizeCanvas())
    // [Playbook Edit]
    // const ro = new ResizeObserver(() => this.resizeCanvas())
    // ro.observe(this.bodyTop)
    // ro.observe(this.bodyLeft)
    // ro.observe(this.bodyRight)
    // ro.observe(this.bodyBottom)

    await useExtensionService().invokeExtensionsAsync('init')
    await this.registerNodes()
    initWidgets(this)

    // Playbook: Disabling this functionality to avoid cached workflow
    // data being loaded on graph load.
    // Load previous workflow
    // let restored = false
    // try {
    //   const loadWorkflow = async (json) => {
    //     if (json) {
    //       const workflow = JSON.parse(json)
    //       const workflowName = getStorageValue('Comfy.PreviousWorkflow')
    //       await this.loadGraphData(workflow, true, true, workflowName)
    //       return true
    //     }
    //   }
    //   const clientId = api.initialClientId ?? api.clientId
    //   restored =
    //     (clientId &&
    //       (await loadWorkflow(
    //         sessionStorage.getItem(`workflow:${clientId}`)
    //       ))) ||
    //     (await loadWorkflow(localStorage.getItem('workflow')))
    // } catch (err) {
    //   console.error('Error loading previous workflow', err)
    // }

    // // We failed to restore a workflow so load the default
    // if (!restored) {
    //   await this.loadGraphData()
    // }

    // Save current workflow automatically
    setInterval(() => {
      const sortNodes = useSettingStore().get('Comfy.Workflow.SortNodeIdOnSave')
      const workflow = JSON.stringify(this.graph.serialize({ sortNodes }))
      localStorage.setItem('workflow', workflow)
      if (api.clientId) {
        sessionStorage.setItem(`workflow:${api.clientId}`, workflow)
      }
    }, 1000)

    this.#addDrawNodeHandler()
    this.#addDropHandler()

    await useExtensionService().invokeExtensionsAsync('setup')

    this.#positionConversion = useCanvasPositionConversion(
      this.canvasContainer,
      this.canvas
    )

    this.waitForPlaybookWrapperOriginToSendSetupComplete()
  }

  waitForPlaybookWrapperOriginToSendSetupCompleteInterval: any = null
  waitForPlaybookWrapperOriginToSendSetupComplete() {
    this.waitForPlaybookWrapperOriginToSendSetupCompleteInterval = setInterval(
      () => {
        console.log(
          'ComfyUI: setup complete: sending ComfyGraphSetupComplete to ',
          this.playbookWrapperOrigin
        )

        if (this.playbookWrapperOrigin) {
          const messageData: WorkflowWindowMessageData = {
            message: 'ComfyGraphSetupComplete'
          }

          if (window.top && this.playbookWrapperOrigin) {
            window.top.postMessage(messageData, this.playbookWrapperOrigin)
          }

          clearInterval(
            this.waitForPlaybookWrapperOriginToSendSetupCompleteInterval
          )
        }
      },
      100
    )
    await this.#invokeExtensionsAsync('setup')

    this.waitForPlaybookWrapperOriginToSendSetupComplete()
  }

  waitForPlaybookWrapperOriginToSendSetupCompleteInterval = null
  waitForPlaybookWrapperOriginToSendSetupComplete() {
    this.waitForPlaybookWrapperOriginToSendSetupCompleteInterval = setInterval(
      () => {
        console.log(
          'ComfyUI: setup complete: sending ComfyGraphSetupComplete to ',
          this.playbookWrapperOrigin
        )

        if (this.playbookWrapperOrigin) {
          const messageData: WorkflowWindowMessageData = {
            message: 'ComfyGraphSetupComplete'
          }

          window.top.postMessage(messageData, this.playbookWrapperOrigin)

          clearInterval(
            this.waitForPlaybookWrapperOriginToSendSetupCompleteInterval
          )
        }
      },
      500
    )
  }

  resizeCanvas() {
    // Limit minimal scale to 1, see https://github.com/comfyanonymous/ComfyUI/pull/845
    const scale = Math.max(window.devicePixelRatio, 1)

    // Clear fixed width and height while calculating rect so it uses 100% instead
    this.canvasEl.height = this.canvasEl.width = NaN
    const { width, height } = this.canvasEl.getBoundingClientRect()
    this.canvasEl.width = Math.round(width * scale)
    this.canvasEl.height = Math.round(height * scale)
    // @ts-expect-error fixme ts strict error
    this.canvasEl.getContext('2d').scale(scale, scale)
    this.canvas?.draw(true, true)
  }

  private updateVueAppNodeDefs(defs: Record<string, ComfyNodeDefV1>) {
    // Frontend only nodes registered by custom nodes.
    // Example: https://github.com/rgthree/rgthree-comfy/blob/dd534e5384be8cf0c0fa35865afe2126ba75ac55/src_web/comfyui/fast_groups_bypasser.ts#L10
    const rawDefs: Record<string, ComfyNodeDefV1> = Object.fromEntries(
      Object.entries(LiteGraph.registered_node_types).map(([name, node]) => [
        name,
        {
          name,
          display_name: name,
          category: node.category || '__frontend_only__',
          input: { required: {}, optional: {} },
          output: [],
          output_name: [],
          output_is_list: [],
          output_node: false,
          python_module: 'custom_nodes.frontend_only',
          description: `Frontend only node for ${name}`
        } as ComfyNodeDefV1
      ])
    )

    const allNodeDefs = {
      ...rawDefs,
      ...defs,
      ...SYSTEM_NODE_DEFS
    }

    const nodeDefStore = useNodeDefStore()
    const nodeDefArray: ComfyNodeDefV1[] = Object.values(allNodeDefs)
    useExtensionService().invokeExtensions(
      'beforeRegisterVueAppNodeDefs',
      nodeDefArray,
      this
    )
    nodeDefStore.updateNodeDefs(nodeDefArray)
  }

  async #getNodeDefs(): Promise<Record<string, ComfyNodeDefV1>> {
    const translateNodeDef = (def: ComfyNodeDefV1): ComfyNodeDefV1 => ({
      ...def,
      display_name: st(
        `nodeDefs.${def.name}.display_name`,
        def.display_name ?? def.name
      ),
      description: def.description
        ? st(`nodeDefs.${def.name}.description`, def.description)
        : '',
      category: def.category
        .split('/')
        .map((category: string) => st(`nodeCategories.${category}`, category))
        .join('/')
    })

    return _.mapValues(
      await api.getNodeDefs({
        validate: useSettingStore().get('Comfy.Validation.NodeDefs')
      }),
      (def) => translateNodeDef(def)
    )
  }

  /**
   * Registers nodes with the graph
   */
  async registerNodes() {
    // Load node definitions from the backend
    const defs = await this.#getNodeDefs()
    await this.registerNodesFromDefs(defs)
    await useExtensionService().invokeExtensionsAsync('registerCustomNodes')
    if (this.vueAppReady) {
      this.updateVueAppNodeDefs(defs)
    }
  }

  async registerNodeDef(nodeId: string, nodeDef: ComfyNodeDefV1) {
    return await useLitegraphService().registerNodeDef(nodeId, nodeDef)
  }

  async registerNodesFromDefs(defs: Record<string, ComfyNodeDefV1>) {
    await useExtensionService().invokeExtensionsAsync('addCustomNodeDefs', defs)

    // Register a node for each definition
    for (const nodeId in defs) {
      this.registerNodeDef(nodeId, defs[nodeId])
    }
  }

  // @ts-expect-error fixme ts strict error
  loadTemplateData(templateData) {
    if (!templateData?.templates) {
      return
    }

    const old = localStorage.getItem('litegrapheditor_clipboard')

    var maxY, nodeBottom, node

    for (const template of templateData.templates) {
      if (!template?.data) {
        continue
      }

      // Check for old clipboard format
      const data = JSON.parse(template.data)
      if (!data.reroutes) {
        deserialiseAndCreate(template.data, app.canvas)
      } else {
        localStorage.setItem('litegrapheditor_clipboard', template.data)
        app.canvas.pasteFromClipboard()
      }

      // Move mouse position down to paste the next template below

      maxY = false

      for (const i in app.canvas.selected_nodes) {
        node = app.canvas.selected_nodes[i]

        nodeBottom = node.pos[1] + node.size[1]

        // @ts-expect-error fixme ts strict error
        if (maxY === false || nodeBottom > maxY) {
          maxY = nodeBottom
        }
      }

      // @ts-expect-error fixme ts strict error
      app.canvas.graph_mouse[1] = maxY + 50
    }

    // @ts-expect-error fixme ts strict error
    localStorage.setItem('litegrapheditor_clipboard', old)
  }

  #showMissingNodesError(missingNodeTypes: MissingNodeType[]) {
    if (useSettingStore().get('Comfy.Workflow.ShowMissingNodesWarning')) {
      useDialogService().showLoadWorkflowWarning({ missingNodeTypes })
    }
  }

  // @ts-expect-error fixme ts strict error
  #showMissingModelsError(missingModels, paths) {
    if (useSettingStore().get('Comfy.Workflow.ShowMissingModelsWarning')) {
      useDialogService().showMissingModelsWarning({
        missingModels,
        paths
      })
    }
  }

  async loadGraphData(
    graphData?: ComfyWorkflowJSON,
    clean: boolean = true,
    restore_view: boolean = true,
    workflow: string | null | ComfyWorkflow = null,
    {
      showMissingNodesDialog = true,
      showMissingModelsDialog = true,
      checkForRerouteMigration = false
    } = {}
  ) {
    if (clean !== false) {
      this.clean()
    }

    let reset_invalid_values = false
    if (!graphData) {
      graphData = defaultGraph
      reset_invalid_values = true
    }

    graphData = clone(graphData)

    if (useSettingStore().get('Comfy.Validation.Workflows')) {
      const { graphData: validatedGraphData } =
        await useWorkflowValidation().validateWorkflow(graphData)

      // If the validation failed, use the original graph data.
      // Ideally we should not block users from loading the workflow.
      graphData = validatedGraphData ?? graphData
    }
    // Only show the reroute migration warning if the workflow does not have native
    // reroutes. Merging reroute network has great complexity, and it is not supported
    // for now.
    // See: https://github.com/Comfy-Org/ComfyUI_frontend/issues/3317
    if (
      checkForRerouteMigration &&
      graphData.version === 0.4 &&
      findLegacyRerouteNodes(graphData).length &&
      noNativeReroutes(graphData)
    ) {
      useToastStore().add({
        group: 'reroute-migration',
        severity: 'warn'
      })
    }
    useWorkflowService().beforeLoadNewGraph()
    useSubgraphService().loadSubgraphs(graphData)

    const missingNodeTypes: MissingNodeType[] = []
    const missingModels: ModelFile[] = []
    await useExtensionService().invokeExtensionsAsync(
      'beforeConfigureGraph',
      graphData,
      missingNodeTypes
    )

    const embeddedModels: ModelFile[] = []

    for (let n of graphData.nodes) {
      // Patch T2IAdapterLoader to ControlNetLoader since they are the same node now
      if (n.type == 'T2IAdapterLoader') n.type = 'ControlNetLoader'
      if (n.type == 'ConditioningAverage ') n.type = 'ConditioningAverage' //typo fix
      if (n.type == 'SDV_img2vid_Conditioning')
        n.type = 'SVD_img2vid_Conditioning' //typo fix

      // Find missing node types
      if (!(n.type in LiteGraph.registered_node_types)) {
        missingNodeTypes.push(n.type)
        n.type = sanitizeNodeName(n.type)
      }

      // Collect models metadata from node
      const selectedModels = getSelectedModelsMetadata(n)
      if (selectedModels?.length) {
        embeddedModels.push(...selectedModels)
      }
    }

    // Merge models from the workflow's root-level 'models' field
    const workflowSchemaV1Models = graphData.models
    if (workflowSchemaV1Models?.length)
      embeddedModels.push(...workflowSchemaV1Models)

    const getModelKey = (model: ModelFile) => model.url || model.hash
    const validModels = embeddedModels.filter(getModelKey)
    const uniqueModels = _.uniqBy(validModels, getModelKey)

    if (
      uniqueModels.length &&
      useSettingStore().get('Comfy.Workflow.ShowMissingModelsWarning')
    ) {
      const modelStore = useModelStore()
      await modelStore.loadModelFolders()
      for (const m of uniqueModels) {
        const modelFolder = await modelStore.getLoadedModelFolder(m.directory)
        // @ts-expect-error
        if (!modelFolder) m.directory_invalid = true

        const modelsAvailable = modelFolder?.models
        const modelExists =
          modelsAvailable &&
          Object.values(modelsAvailable).some(
            (model) => model.file_name === m.name
          )
        if (!modelExists) missingModels.push(m)
      }
    }

    try {
      // @ts-expect-error Discrepancies between zod and litegraph - in progress
      this.graph.configure(graphData)
      if (
        restore_view &&
        useSettingStore().get('Comfy.EnableWorkflowViewRestore')
      ) {
        if (graphData.extra?.ds) {
          this.canvas.ds.offset = graphData.extra.ds.offset
          this.canvas.ds.scale = graphData.extra.ds.scale
        } else {
          // @note: Set view after the graph has been rendered once. fitView uses
          // boundingRect on nodes to calculate the view bounds, which only become
          // available after the first render.
          requestAnimationFrame(() => {
            useLitegraphService().fitView()
          })
        }
      }
    } catch (error) {
      useDialogService().showErrorDialog(error, {
        title: t('errorDialog.loadWorkflowTitle'),
        reportType: 'loadWorkflowError'
      })
      console.error(error)
      return
    }
    for (const node of this.graph.nodes) {
      const size = node.computeSize()
      size[0] = Math.max(node.size[0], size[0])
      size[1] = Math.max(node.size[1], size[1])
      node.setSize(size)
      if (node.widgets) {
        // If you break something in the backend and want to patch workflows in the frontend
        // This is the place to do this
        for (let widget of node.widgets) {
          if (node.type == 'KSampler' || node.type == 'KSamplerAdvanced') {
            if (widget.name == 'sampler_name') {
              if (
                typeof widget.value === 'string' &&
                widget.value.startsWith('sample_')
              ) {
                widget.value = widget.value.slice(7)
              }
            }
          }
          if (
            node.type == 'KSampler' ||
            node.type == 'KSamplerAdvanced' ||
            node.type == 'PrimitiveNode'
          ) {
            if (widget.name == 'control_after_generate') {
              if (widget.value === true) {
                widget.value = 'randomize'
              } else if (widget.value === false) {
                widget.value = 'fixed'
              }
            }
          }
          if (reset_invalid_values) {
            if (widget.type == 'combo') {
              if (
                // @ts-expect-error fixme ts strict error
                !widget.options.values.includes(widget.value as string) &&
                // @ts-expect-error fixme ts strict error
                widget.options.values.length > 0
              ) {
                // @ts-expect-error fixme ts strict error
                widget.value = widget.options.values[0]
              }
            }
          }
        }
      }

      useExtensionService().invokeExtensions('loadedGraphNode', node)
    }

    if (missingNodeTypes.length && showMissingNodesDialog) {
      this.#showMissingNodesError(missingNodeTypes)
    }
    if (missingModels.length && showMissingModelsDialog) {
      const paths = await api.getFolderPaths()
      this.#showMissingModelsError(missingModels, paths)
    }
    await useExtensionService().invokeExtensionsAsync(
      'afterConfigureGraph',
      missingNodeTypes
    )
    await useWorkflowService().afterLoadNewGraph(
      workflow,
      this.graph.serialize() as unknown as ComfyWorkflowJSON
    )
    requestAnimationFrame(() => {
      this.graph.setDirtyCanvas(true, true)
    })

    // Send updated workflow data to Playbook wrapper if graph changed.
    if (window.__COMFYAPP && this.playbookWrapperOrigin) {
      sendWorkflowDataToPlaybookWrapper(this.playbookWrapperOrigin)
    }
    if (window.__COMFYAPP) window.__COMFYAPP.sendWorkflowDataToPlaybookWrapper()
  }

  async graphToPrompt(
    graph = this.graph,
    options: { queueNodeIds?: NodeId[] } = {}
  ) {
    return graphToPrompt(graph, {
      sortNodes: useSettingStore().get('Comfy.Workflow.SortNodeIdOnSave'),
      queueNodeIds: options.queueNodeIds
    })
  }

  #formatPromptError(error) {
    if (error == null) {
      return '(unknown error)'
    } else if (typeof error === 'string') {
      return error
    } else if (error.stack && error.message) {
      return error.toString()
    } else if (error.response) {
      let message = error.response.error.message
      if (error.response.error.details)
        message += ': ' + error.response.error.details
      for (const [nodeID, nodeError] of Object.entries(
        error.response.node_errors
      )) {
        // @ts-expect-error
        message += '\n' + nodeError.class_type + ':'
        // @ts-expect-error
        for (const errorReason of nodeError.errors) {
          message +=
            '\n    - ' + errorReason.message + ': ' + errorReason.details
        }
      }
      return message
    }
    return '(unknown error)'
  }

  async queuePrompt(number, batchCount = 1) {
    this.#queueItems.push({ number, batchCount })

    // Only have one action process the items so each one gets a unique seed correctly
    if (this.#processingQueue) {
      return false
    }

    this.#processingQueue = true
    const executionStore = useExecutionStore()
    executionStore.lastNodeErrors = null

    let comfyOrgAuthToken =
      (await useFirebaseAuthStore().getIdToken()) ?? undefined
    let comfyOrgApiKey = useApiKeyAuthStore().getApiKey()

    try {
      while (this.#queueItems.length) {
        const { number, batchCount, queueNodeIds } = this.#queueItems.pop()!

        for (let i = 0; i < batchCount; i++) {
          // Allow widgets to run callbacks before a prompt has been queued
          // e.g. random seed before every gen
          executeWidgetsCallback(this.graph.nodes, 'beforeQueued')
          for (const subgraph of this.graph.subgraphs.values()) {
            executeWidgetsCallback(subgraph.nodes, 'beforeQueued')
          }

          const p = await this.graphToPrompt(this.graph, { queueNodeIds })
          try {
            api.authToken = comfyOrgAuthToken
            api.apiKey = comfyOrgApiKey ?? undefined
            const res = await api.queuePrompt(number, p)
            delete api.authToken
            delete api.apiKey
            executionStore.lastNodeErrors = res.node_errors ?? null
            if (executionStore.lastNodeErrors?.length) {
              this.canvas.draw(true, true)
            } else {
              try {
                if (res.prompt_id) {
                  executionStore.storePrompt({
                    id: res.prompt_id,
                    nodes: Object.keys(p.output),
                    workflow: useWorkspaceStore().workflow
                      .activeWorkflow as ComfyWorkflow
                  })
                }
              } catch (error) {}
            }
          } catch (error: unknown) {
            useDialogService().showErrorDialog(error, {
              title: t('errorDialog.promptExecutionError'),
              reportType: 'promptExecutionError'
            })
            console.error(error)

            if (error instanceof PromptExecutionError) {
              executionStore.lastNodeErrors = error.response.node_errors ?? null
              this.canvas.draw(true, true)
            }
            break
          }

          // Allow widgets to run callbacks after a prompt has been queued
          // e.g. random seed after every gen
          executeWidgetsCallback(
            p.workflow.nodes
              .map((n) => this.graph.getNodeById(n.id))
              .filter((n) => !!n),
            'afterQueued'
          )
          for (const subgraph of this.graph.subgraphs.values()) {
            executeWidgetsCallback(subgraph.nodes, 'afterQueued')
          }

          this.canvas.draw(true, true)
          await this.ui.queue.update()
        }
      }
    } finally {
      this.#processingQueue = false
    }
    api.dispatchCustomEvent('promptQueued', { number, batchCount })
    return !executionStore.lastNodeErrors
  }

  showErrorOnFileLoad(file: File) {
    useToastStore().addAlert(
      t('toastMessages.fileLoadError', { fileName: file.name })
    )
  }

  /**
   * Loads workflow data from the specified file
   * @param {File} file
   */
  async handleFile(file: File) {
    const removeExt = (f: string) => {
      if (!f) return f
      const p = f.lastIndexOf('.')
      if (p === -1) return f
      return f.substring(0, p)
    }
    const fileName = removeExt(file.name)
    if (file.type === 'image/png') {
      const pngInfo = await getPngMetadata(file)
      if (pngInfo?.workflow) {
        await this.loadGraphData(
          JSON.parse(pngInfo.workflow),
          true,
          true,
          fileName
        )
      } else if (pngInfo?.prompt) {
        this.loadApiJson(JSON.parse(pngInfo.prompt), fileName)
      } else if (pngInfo?.parameters) {
        // Note: Not putting this in `importA1111` as it is mostly not used
        // by external callers, and `importA1111` has no access to `app`.
        useWorkflowService().beforeLoadNewGraph()
        importA1111(this.graph, pngInfo.parameters)
        useWorkflowService().afterLoadNewGraph(
          fileName,
          this.graph.serialize() as unknown as ComfyWorkflowJSON
        )
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'image/webp') {
      const pngInfo = await getWebpMetadata(file)
      // Support loading workflows from that webp custom node.
      const workflow = pngInfo?.workflow || pngInfo?.Workflow
      const prompt = pngInfo?.prompt || pngInfo?.Prompt

      if (workflow) {
        this.loadGraphData(JSON.parse(workflow), true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(JSON.parse(prompt), fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'audio/mpeg') {
      const { workflow, prompt } = await getMp3Metadata(file)
      if (workflow) {
        this.loadGraphData(workflow, true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'audio/ogg') {
      const { workflow, prompt } = await getOggMetadata(file)
      if (workflow) {
        this.loadGraphData(workflow, true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'audio/flac' || file.type === 'audio/x-flac') {
      const pngInfo = await getFlacMetadata(file)
      const workflow = pngInfo?.workflow || pngInfo?.Workflow
      const prompt = pngInfo?.prompt || pngInfo?.Prompt

      if (workflow) {
        this.loadGraphData(JSON.parse(workflow), true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(JSON.parse(prompt), fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'video/webm') {
      const webmInfo = await getFromWebmFile(file)
      if (webmInfo.workflow) {
        this.loadGraphData(webmInfo.workflow, true, true, fileName)
      } else if (webmInfo.prompt) {
        this.loadApiJson(webmInfo.prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (
      file.type === 'video/mp4' ||
      file.name?.endsWith('.mp4') ||
      file.name?.endsWith('.mov') ||
      file.name?.endsWith('.m4v') ||
      file.type === 'video/quicktime' ||
      file.type === 'video/x-m4v'
    ) {
      const mp4Info = await getFromIsobmffFile(file)
      if (mp4Info.workflow) {
        this.loadGraphData(mp4Info.workflow, true, true, fileName)
      } else if (mp4Info.prompt) {
        this.loadApiJson(mp4Info.prompt, fileName)
      }
    } else if (file.type === 'image/svg+xml' || file.name?.endsWith('.svg')) {
      const svgInfo = await getSvgMetadata(file)
      if (svgInfo.workflow) {
        this.loadGraphData(svgInfo.workflow, true, true, fileName)
      } else if (svgInfo.prompt) {
        this.loadApiJson(svgInfo.prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (
      file.type === 'model/gltf-binary' ||
      file.name?.endsWith('.glb')
    ) {
      const gltfInfo = await getGltfBinaryMetadata(file)
      if (gltfInfo.workflow) {
        this.loadGraphData(gltfInfo.workflow, true, true, fileName)
      } else if (gltfInfo.prompt) {
        this.loadApiJson(gltfInfo.prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (
      file.type === 'application/json' ||
      file.name?.endsWith('.json')
    ) {
      // Playbook Edit: Disabling import of ComfyUI workflow JSON files.
      return
      const reader = new FileReader()
      reader.onload = async () => {
        const readerResult = reader.result as string
        const jsonContent = JSON.parse(readerResult)
        if (jsonContent?.templates) {
          this.loadTemplateData(jsonContent)
        } else if (this.isApiJson(jsonContent)) {
          this.loadApiJson(jsonContent, fileName)
        } else {
          await this.loadGraphData(
            JSON.parse(readerResult),
            true,
            true,
            fileName
          )
          notifyPlaybookWrapperNewWorkflowLoaded(this.playbookWrapperOrigin)
        }
      }
      reader.readAsText(file)
    } else if (
      file.name?.endsWith('.latent') ||
      file.name?.endsWith('.safetensors')
    ) {
      const info = await getLatentMetadata(file)
      // TODO define schema to LatentMetadata
      // @ts-expect-error
      if (info.workflow) {
        await this.loadGraphData(
          // @ts-expect-error
          JSON.parse(info.workflow),
          true,
          true,
          fileName
        )
        // @ts-expect-error
      } else if (info.prompt) {
        // @ts-expect-error
        this.loadApiJson(JSON.parse(info.prompt))
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else {
      this.showErrorOnFileLoad(file)
    }
  }

  isApiJson(data: unknown) {
    return _.isObject(data) && Object.values(data).every((v) => v.class_type)
  }

  loadApiJson(apiData: ComfyApiWorkflow, fileName: string) {
    useWorkflowService().beforeLoadNewGraph()

    const missingNodeTypes = Object.values(apiData).filter(
      (n) => !LiteGraph.registered_node_types[n.class_type]
    )
    if (missingNodeTypes.length) {
      this.#showMissingNodesError(missingNodeTypes.map((t) => t.class_type))
      return
    }

    const ids = Object.keys(apiData)
    app.graph.clear()
    for (const id of ids) {
      const data = apiData[id]
      const node = LiteGraph.createNode(data.class_type)
      if (!node) continue
      node.id = isNaN(+id) ? id : +id
      node.title = data._meta?.title ?? node.title
      app.graph.add(node)
    }

    for (const id of ids) {
      const data = apiData[id]
      const node = app.graph.getNodeById(id)
      for (const input in data.inputs ?? {}) {
        const value = data.inputs[input]
        if (value instanceof Array) {
          const [fromId, fromSlot] = value
          const fromNode = app.graph.getNodeById(fromId)
          // @ts-expect-error fixme ts strict error
          let toSlot = node.inputs?.findIndex((inp) => inp.name === input)
          if (toSlot == null || toSlot === -1) {
            try {
              // Target has no matching input, most likely a converted widget
              // @ts-expect-error fixme ts strict error
              const widget = node.widgets?.find((w) => w.name === input)
              // @ts-expect-error
              if (widget && node.convertWidgetToInput?.(widget)) {
                // @ts-expect-error fixme ts strict error
                toSlot = node.inputs?.length - 1
              }
            } catch (error) {}
          }
          if (toSlot != null || toSlot !== -1) {
            // @ts-expect-error fixme ts strict error
            fromNode.connect(fromSlot, node, toSlot)
          }
        } else {
          // @ts-expect-error fixme ts strict error
          const widget = node.widgets?.find((w) => w.name === input)
          if (widget) {
            widget.value = value
            widget.callback?.(value)
          }
        }
      }
    }
    app.graph.arrange()

    for (const id of ids) {
      const data = apiData[id]
      const node = app.graph.getNodeById(id)
      for (const input in data.inputs ?? {}) {
        const value = data.inputs[input]
        if (value instanceof Array) {
          const [fromId, fromSlot] = value
          const fromNode = app.graph.getNodeById(fromId)
          // @ts-expect-error fixme ts strict error
          let toSlot = node.inputs?.findIndex((inp) => inp.name === input)
          if (toSlot == null || toSlot === -1) {
            try {
              // Target has no matching input, most likely a converted widget
              // @ts-expect-error fixme ts strict error
              const widget = node.widgets?.find((w) => w.name === input)
              // @ts-expect-error
              if (widget && node.convertWidgetToInput?.(widget)) {
                // @ts-expect-error fixme ts strict error
                toSlot = node.inputs?.length - 1
              }
            } catch (error) {}
          }
          if (toSlot != null || toSlot !== -1) {
            // @ts-expect-error fixme ts strict error
            fromNode.connect(fromSlot, node, toSlot)
          }
        } else {
          // @ts-expect-error fixme ts strict error
          const widget = node.widgets?.find((w) => w.name === input)
          if (widget) {
            widget.value = value
            widget.callback?.(value)
          }
        }
      }
    }

    app.graph.arrange()

    useWorkflowService().afterLoadNewGraph(
      fileName,
      this.graph.serialize() as unknown as ComfyWorkflowJSON
    )
  }

  /**
   * Registers a Comfy web extension with the app
   * @param {ComfyExtension} extension
   */
  registerExtension(extension: ComfyExtension) {
    useExtensionService().registerExtension(extension)
  }

  /**
   * Refresh combo list on whole nodes
   */
  async refreshComboInNodes() {
    const requestToastMessage: ToastMessageOptions = {
      severity: 'info',
      summary: t('g.update'),
      detail: t('toastMessages.updateRequested')
    }
    if (this.vueAppReady) {
      useToastStore().add(requestToastMessage)
    }

    const defs = await this.#getNodeDefs()
    for (const nodeId in defs) {
      this.registerNodeDef(nodeId, defs[nodeId])
    }
    for (const node of this.graph.nodes) {
      const def = defs[node.type]
      // Allow primitive nodes to handle refresh
      node.refreshComboInNode?.(defs)

      if (!def?.input) continue

      if (node.widgets) {
        const nodeInputs = def.input
        for (const widget of node.widgets) {
          if (widget.type === 'combo') {
            let inputType: 'required' | 'optional' | undefined
            if (nodeInputs.required?.[widget.name] !== undefined) {
              inputType = 'required'
            } else if (nodeInputs.optional?.[widget.name] !== undefined) {
              inputType = 'optional'
            }
            if (inputType !== undefined) {
              // Get the input spec associated with the widget
              const inputSpec = nodeInputs[inputType]?.[widget.name]
              if (inputSpec) {
                // Refresh the combo widget's options with the values from the input spec
                if (isComboInputSpecV2(inputSpec)) {
                  widget.options.values = inputSpec[1]?.options
                } else if (isComboInputSpecV1(inputSpec)) {
                  widget.options.values = inputSpec[0]
                }
              }
            }
          }
        }
      }
    }

    await useExtensionService().invokeExtensionsAsync(
      'refreshComboInNodes',
      defs
    )

    if (this.vueAppReady) {
      this.updateVueAppNodeDefs(defs)
      useToastStore().remove(requestToastMessage)
      useToastStore().add({
        severity: 'success',
        summary: t('g.updated'),
        detail: t('toastMessages.nodeDefinitionsUpdated'),
        life: 1000
      })
    }
  }

  /**
   * Frees memory allocated to image preview blobs for a specific node, by revoking the URLs associated with them.
   * @param nodeId ID of the node to revoke all preview images of
   */
  revokePreviews(nodeId: NodeId) {
    if (!this.nodePreviewImages[nodeId]?.[Symbol.iterator]) return
    for (const url of this.nodePreviewImages[nodeId]) {
      URL.revokeObjectURL(url)
    }
  }
  /**
   * Clean current state
   */
  clean() {
    this.nodeOutputs = {}
    for (const id of Object.keys(this.nodePreviewImages)) {
      this.revokePreviews(id)
    }
    this.nodePreviewImages = {}
    const executionStore = useExecutionStore()
    executionStore.lastNodeErrors = null
    executionStore.lastExecutionError = null

    useDomWidgetStore().clear()
  }

  clientPosToCanvasPos(pos: Vector2): Vector2 {
    if (!this.#positionConversion) {
      throw new Error('clientPosToCanvasPos called before setup')
    }
    return this.#positionConversion.clientPosToCanvasPos(pos)
  }

  canvasPosToClientPos(pos: Vector2): Vector2 {
    if (!this.#positionConversion) {
      throw new Error('canvasPosToClientPos called before setup')
    }
    return this.#positionConversion.canvasPosToClientPos(pos)
  }
}

export const app = new ComfyApp()
