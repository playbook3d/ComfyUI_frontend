import axios from 'axios'

import type {
  DisplayComponentWsMessage,
  EmbeddingsResponse,
  ExecutedWsMessage,
  ExecutingWsMessage,
  ExecutionCachedWsMessage,
  ExecutionErrorWsMessage,
  ExecutionInterruptedWsMessage,
  ExecutionStartWsMessage,
  ExecutionSuccessWsMessage,
  ExtensionsResponse,
  HistoryTaskItem,
  LogsRawResponse,
  LogsWsMessage,
  PendingTaskItem,
  ProgressTextWsMessage,
  ProgressWsMessage,
  PromptResponse,
  RunningTaskItem,
  Settings,
  StatusWsMessage,
  StatusWsMessageStatus,
  SystemStats,
  User,
  UserDataFullInfo
} from '@/schemas/apiSchema'

import config from '@/config'

import type {
  ComfyApiWorkflow,
  ComfyWorkflowJSON,
  NodeId
} from '@/schemas/comfyWorkflowSchema'

import {
  type ComfyNodeDef,
  validateComfyNodeDef
} from '@/schemas/nodeDefSchema'

import { WorkflowTemplates } from '@/types/workflowTemplateTypes'
import { AccountsApi } from './accountsApi'

interface QueuePromptRequestBody {
  client_id: string
  prompt: ComfyApiWorkflow
  extra_data: {
    extra_pnginfo: {
      workflow: ComfyWorkflowJSON
    }
    /**
     * The auth token for the comfy org account if the user is logged in.
     *
     * Backend node can access this token by specifying following input:
     * ```python
      @classmethod
      def INPUT_TYPES(s):
        return {
          "hidden": { "auth_token": "AUTH_TOKEN_COMFY_ORG"}
        }

      def execute(self, auth_token: str):
        print(f"Auth token: {auth_token}")
     * ```
     */
    auth_token_comfy_org?: string
    /**
     * The auth token for the comfy org account if the user is logged in.
     *
     * Backend node can access this token by specifying following input:
     * ```python
     * def INPUT_TYPES(s):
     *   return {
     *     "hidden": { "api_key": "API_KEY_COMFY_ORG" }
     *   }
     *
     * def execute(self, api_key: str):
     *   print(f"API Key: {api_key}")
     * ```
     */
    api_key_comfy_org?: string
  }
  front?: boolean
  number?: number
}

/** Dictionary of Frontend-generated API calls */
interface FrontendApiCalls {
  graphChanged: ComfyWorkflowJSON
  promptQueued: { number: number; batchCount: number }
  graphCleared: never
  reconnecting: never
  reconnected: never
}

/** Dictionary of calls originating from ComfyUI core */
interface BackendApiCalls {
  progress: ProgressWsMessage
  executing: ExecutingWsMessage
  executed: ExecutedWsMessage
  status: StatusWsMessage
  execution_start: ExecutionStartWsMessage
  execution_success: ExecutionSuccessWsMessage
  execution_error: ExecutionErrorWsMessage
  execution_interrupted: ExecutionInterruptedWsMessage
  execution_cached: ExecutionCachedWsMessage
  logs: LogsWsMessage
  /** Binary preview/progress data */
  b_preview: Blob
  progress_text: ProgressTextWsMessage
  display_component: DisplayComponentWsMessage
}

/** Dictionary of all api calls */
interface ApiCalls extends BackendApiCalls, FrontendApiCalls {}

/** Used to create a discriminating union on type value. */
interface ApiMessage<T extends keyof ApiCalls> {
  type: T
  data: ApiCalls[T]
}

export class UnauthorizedError extends Error {}

/** Ensures workers get a fair shake. */
type Unionize<T> = T[keyof T]

/**
 *  Discriminated union of generic, i.e.:
 * ```ts
 * // Convert
 * type ApiMessageUnion = ApiMessage<'status' | 'executing' | ...>
 * // To
 * type ApiMessageUnion = ApiMessage<'status'> | ApiMessage<'executing'> | ...
 * ```
 */
type ApiMessageUnion = Unionize<{
  [Key in keyof ApiCalls]: ApiMessage<Key>
}>

/** Wraps all properties in {@link CustomEvent}. */
type AsCustomEvents<T> = {
  readonly [K in keyof T]: CustomEvent<T[K]>
}

/** Handles differing event and API signatures. */
type ApiToEventType<T = ApiCalls> = {
  [K in keyof T]: K extends 'status'
    ? StatusWsMessageStatus
    : K extends 'executing'
      ? NodeId
      : T[K]
}

/** Dictionary of types used in the detail for a custom event */
type ApiEventTypes = ApiToEventType<ApiCalls>

/** Dictionary of API events: `[name]: CustomEvent<Type>` */
type ApiEvents = AsCustomEvents<ApiEventTypes>

/** {@link Omit} all properties that evaluate to `never`. */
type NeverNever<T> = {
  [K in keyof T as T[K] extends never ? never : K]: T[K]
}

/** {@link Pick} only properties that evaluate to `never`. */
type PickNevers<T> = {
  [K in keyof T as T[K] extends never ? K : never]: T[K]
}

/** Keys (names) of API events that _do not_ pass a {@link CustomEvent} `detail` object. */
type SimpleApiEvents = keyof PickNevers<ApiEventTypes>
/** Keys (names) of API events that pass a {@link CustomEvent} `detail` object. */
type ComplexApiEvents = keyof NeverNever<ApiEventTypes>

/** EventTarget typing has no generic capability. */
export interface ComfyApi extends EventTarget {
  addEventListener<TEvent extends keyof ApiEvents>(
    type: TEvent,
    callback: ((event: ApiEvents[TEvent]) => void) | null,
    options?: AddEventListenerOptions | boolean
  ): void

  removeEventListener<TEvent extends keyof ApiEvents>(
    type: TEvent,
    callback: ((event: ApiEvents[TEvent]) => void) | null,
    options?: EventListenerOptions | boolean
  ): void
}

export class PromptExecutionError extends Error {
  response: PromptResponse

  constructor(response: PromptResponse) {
    super('Prompt execution failed')
    this.response = response
  }

  override toString() {
    let message = ''
    if (typeof this.response.error === 'string') {
      message += this.response.error
    } else if (this.response.error) {
      message +=
        this.response.error.message + ': ' + this.response.error.details
    }

    for (const [_, nodeError] of Object.entries(
      this.response.node_errors ?? []
    )) {
      message += '\n' + nodeError.class_type + ':'
      for (const errorReason of nodeError.errors) {
        message += '\n    - ' + errorReason.message + ': ' + errorReason.details
      }
    }

    return message
  }
}

export class ComfyApi extends EventTarget {
  #registered = new Set()
  api_host: string
  api_base: string
  /**
   * The client id from the initial session storage.
   */
  initialClientId: string | null
  /**
   * The current client id from websocket status updates.
   */
  clientId?: string

  is_offline: boolean = false
  
  /**
   * The current user id.
   */
  user: string
  socket: WebSocket | null = null

  reportedUnknownMessageTypes = new Set<string>()

  /**
   * The auth token for the comfy org account if the user is logged in.
   * This is only used for {@link queuePrompt} now. It is not directly
   * passed as parameter to the function because some custom nodes are hijacking
   * {@link queuePrompt} improperly, which causes extra parameters to be lost
   * in the function call chain.
   *
   * Ref: https://cs.comfy.org/search?q=context:global+%22api.queuePrompt+%3D%22&patternType=keyword&sm=0
   *
   * TODO: Move this field to parameter of {@link queuePrompt} once all
   * custom nodes are patched.
   */
  authToken?: string
  /**
   * The API key for the comfy org account if the user logged in via API key.
   */
  apiKey?: string
  accountsApi: AccountsApi
  constructor() {
    super()
    this.accountsApi = new AccountsApi(import.meta.env.VITE_MODAL_API, import.meta.env.VITE_API_KEY)

    // @ts-expect-error fixme ts strict error
    window['__COMFYUI_FRONTEND_VERSION__'] = config.app_version
    console.log('ComfyUI Front-end version:', config.app_version)
    this.user = ''
    this.api_host = location.host
    this.api_base = 'app_url'
    console.log('Running on', this.api_host)
    this.initialClientId = sessionStorage.getItem('clientId')
    this.is_offline = config.offline
  }

  internalURL(route: string): string {
    return this.api_base + '/internal' + route
  }

  async apiURL(route: string): Promise<string> {
    const urlParams = new URLSearchParams(window.location.search)
    let teamId
    if (urlParams.has('team_id')) {
      teamId = urlParams.get('team_id')
    }
    const { app_url, user_jwt, workflow_id } = await (
      await this.accountsApi.getInfo(teamId as string) as any
    ).json()
    return app_url + '/api' + route
  }

  fileURL(route: string): string {
    return this.api_base + route
  }

  async getWorkflow(workflowId?: string) {
    const urlParams = new URLSearchParams(window.location.search)
    let teamId
    if (urlParams.has('team_id')) {
      teamId = urlParams.get('team_id')
    }
    const { _app_url, user_jwt, workflow_id } = await (
      await this.accountsApi.getInfo(teamId as string) as any
    ).json()
    const stringMockWorkflow = `{"id":"32a25f4c-e76f-427c-b023-2b7dd17cc5c7","revision":0,"last_node_id":40,"last_link_id":119,"nodes":[{"id":17,"type":"BasicScheduler","pos":[480,1008],"size":[315,106],"flags":{},"order":9,"mode":0,"inputs":[{"name":"model","type":"MODEL","link":55}],"outputs":[{"name":"SIGMAS","type":"SIGMAS","links":[20]}],"properties":{"Node name for S&R":"BasicScheduler"},"widgets_values":["simple",20,1]},{"id":16,"type":"KSamplerSelect","pos":[480,912],"size":[315,58],"flags":{},"order":0,"mode":0,"inputs":[],"outputs":[{"name":"SAMPLER","type":"SAMPLER","links":[19]}],"properties":{"Node name for S&R":"KSamplerSelect"},"widgets_values":["euler"]},{"id":26,"type":"FluxGuidance","pos":[480,144],"size":[317.4000244140625,58],"flags":{},"order":8,"mode":0,"inputs":[{"name":"conditioning","type":"CONDITIONING","link":41}],"outputs":[{"name":"CONDITIONING","type":"CONDITIONING","slot_index":0,"links":[42]}],"properties":{"Node name for S&R":"FluxGuidance"},"widgets_values":[3.5]},{"id":13,"type":"SamplerCustomAdvanced","pos":[864,192],"size":[272.3617858886719,124.53733825683594],"flags":{},"order":11,"mode":0,"inputs":[{"name":"noise","type":"NOISE","link":37},{"name":"guider","type":"GUIDER","link":30},{"name":"sampler","type":"SAMPLER","link":19},{"name":"sigmas","type":"SIGMAS","link":20},{"name":"latent_image","type":"LATENT","link":116}],"outputs":[{"name":"output","type":"LATENT","slot_index":0,"links":[24]},{"name":"denoised_output","type":"LATENT","links":null}],"properties":{"Node name for S&R":"SamplerCustomAdvanced"},"widgets_values":[]},{"id":8,"type":"VAEDecode","pos":[866,367],"size":[210,46],"flags":{},"order":12,"mode":0,"inputs":[{"name":"samples","type":"LATENT","link":24},{"name":"vae","type":"VAE","link":12}],"outputs":[{"name":"IMAGE","type":"IMAGE","slot_index":0,"links":[9]}],"properties":{"Node name for S&R":"VAEDecode"},"widgets_values":[]},{"id":30,"type":"ModelSamplingFlux","pos":[480,1152],"size":[315,130],"flags":{},"order":7,"mode":0,"inputs":[{"name":"model","type":"MODEL","link":56}],"outputs":[{"name":"MODEL","type":"MODEL","slot_index":0,"links":[54,55]}],"properties":{"Node name for S&R":"ModelSamplingFlux"},"widgets_values":[1.15,0.5,1024,1024]},{"id":27,"type":"EmptySD3LatentImage","pos":[480,624],"size":[315,106],"flags":{},"order":1,"mode":0,"inputs":[],"outputs":[{"name":"LATENT","type":"LATENT","slot_index":0,"links":[116]}],"properties":{"Node name for S&R":"EmptySD3LatentImage"},"widgets_values":[1024,1024,1]},{"id":22,"type":"BasicGuider","pos":[588.820556640625,43.92744827270508],"size":[222.3482666015625,46],"flags":{},"order":10,"mode":0,"inputs":[{"name":"model","type":"MODEL","link":54},{"name":"conditioning","type":"CONDITIONING","link":42}],"outputs":[{"name":"GUIDER","type":"GUIDER","slot_index":0,"links":[30]}],"properties":{"Node name for S&R":"BasicGuider"},"widgets_values":[]},{"id":10,"type":"VAELoader","pos":[61.54898452758789,1236.017578125],"size":[311.81634521484375,60.429901123046875],"flags":{},"order":2,"mode":0,"inputs":[],"outputs":[{"name":"VAE","type":"VAE","slot_index":0,"links":[12]}],"properties":{"Node name for S&R":"VAELoader"},"widgets_values":["ae.safetensors"]},{"id":11,"type":"DualCLIPLoader","pos":[43.60044860839844,1064.43505859375],"size":[315,130],"flags":{},"order":3,"mode":0,"inputs":[],"outputs":[{"name":"CLIP","type":"CLIP","slot_index":0,"links":[10]}],"properties":{"Node name for S&R":"DualCLIPLoader"},"widgets_values":["t5xxl_fp16.safetensors","clip_l.safetensors","flux","default"]},{"id":12,"type":"UNETLoader","pos":[28.34018325805664,909.1227416992188],"size":[315,82],"flags":{},"order":4,"mode":0,"inputs":[],"outputs":[{"name":"MODEL","type":"MODEL","slot_index":0,"links":[56]}],"properties":{"Node name for S&R":"UNETLoader"},"widgets_values":["flux1-dev.safetensors","default"]},{"id":9,"type":"SaveImage","pos":[1269.0985107421875,193.5947265625],"size":[511.04693603515625,477.54815673828125],"flags":{},"order":13,"mode":0,"inputs":[{"name":"images","type":"IMAGE","link":9}],"outputs":[],"properties":{"Node name for S&R":"SaveImage"},"widgets_values":["ComfyUI"]},{"id":25,"type":"RandomNoise","pos":[495.1676025390625,777.5550537109375],"size":[315,82],"flags":{},"order":5,"mode":0,"inputs":[],"outputs":[{"name":"NOISE","type":"NOISE","links":[37]}],"properties":{"Node name for S&R":"RandomNoise"},"widgets_values":[195992730087197,"randomize"]},{"id":6,"type":"CLIPTextEncode","pos":[379.29315185546875,258.0357971191406],"size":[422.84503173828125,164.31304931640625],"flags":{},"order":6,"mode":0,"inputs":[{"name":"clip","type":"CLIP","link":10}],"outputs":[{"name":"CONDITIONING","type":"CONDITIONING","slot_index":0,"links":[41]}],"title":"CLIP Text Encode (Positive Prompt)","properties":{"Node name for S&R":"CLIPTextEncode"},"widgets_values":["skateboards"]}],"links":[[9,8,0,9,0,"IMAGE"],[10,11,0,6,0,"CLIP"],[12,10,0,8,1,"VAE"],[19,16,0,13,2,"SAMPLER"],[20,17,0,13,3,"SIGMAS"],[24,13,0,8,0,"LATENT"],[30,22,0,13,1,"GUIDER"],[37,25,0,13,0,"NOISE"],[41,6,0,26,0,"CONDITIONING"],[42,26,0,22,1,"CONDITIONING"],[54,30,0,22,0,"MODEL"],[55,30,0,17,0,"MODEL"],[56,12,0,30,0,"MODEL"],[116,27,0,13,4,"LATENT"]],"groups":[],"config":{},"extra":{"ds":{"scale":0.7247295000000004,"offset":[463.92774200571637,-163.09693890974512]},"frontendVersion":"1.16.9","groupNodes":{},"node_versions":{"comfy-core":"0.3.29"},"ue_links":[],"VHS_latentpreview":false,"VHS_latentpreviewrate":0},"version":0.4}`
    //return new Promise<Response>((resolve) => resolve(new Response(stringMockWorkflow)))
    // return this.fetchApi('/workflows/' + workflowId)}
    return this.accountsApi.getWorkflow(workflow_id, user_jwt)
  }

  async fetchApi(route: string, dataToReturn?: any, options?: RequestInit) {
    if (this.is_offline) {
      return new Promise<Response>((resolve) =>
        resolve(new Response(JSON.stringify(dataToReturn, null)))
      )
    }
    if (!options) {
      options = {}
    }
    if (!options.headers) {
      options.headers = {}
    }
    if (!options.cache) {
      options.cache = 'no-cache'
    }

    // if (Array.isArray(options.headers)) {
    //   options.headers.push(['Comfy-User', this.user])
    // } else if (options.headers instanceof Headers) {
    //   options.headers.set('Comfy-User', this.user)
    // } else {
    //   options.headers['Comfy-User'] = this.user
    // }
    return fetch(await this.apiURL(route), options)
  }

  override addEventListener<TEvent extends keyof ApiEvents>(
    type: TEvent,
    callback: ((event: ApiEvents[TEvent]) => void) | null,
    options?: AddEventListenerOptions | boolean
  ) {
    // Type assertion: strictFunctionTypes.  So long as we emit events in a type-safe fashion, this is safe.
    super.addEventListener(type, callback as EventListener, options)
    this.#registered.add(type)
  }

  override removeEventListener<TEvent extends keyof ApiEvents>(
    type: TEvent,
    callback: ((event: ApiEvents[TEvent]) => void) | null,
    options?: EventListenerOptions | boolean
  ): void {
    super.removeEventListener(type, callback as EventListener, options)
  }

  /**
   * Dispatches a custom event.
   * Provides type safety for the contravariance issue with EventTarget (last checked TS 5.6).
   * @param type The type of event to emit
   * @param detail The detail property used for a custom event ({@link CustomEventInit.detail})
   */
  dispatchCustomEvent<T extends SimpleApiEvents>(type: T): boolean
  dispatchCustomEvent<T extends ComplexApiEvents>(
    type: T,
    detail: ApiEventTypes[T] | null
  ): boolean
  dispatchCustomEvent<T extends keyof ApiEventTypes>(
    type: T,
    detail?: ApiEventTypes[T]
  ): boolean {
    const event =
      detail === undefined
        ? new CustomEvent(type)
        : new CustomEvent(type, { detail })
    return super.dispatchEvent(event)
  }

  /** @deprecated Use {@link dispatchCustomEvent}. */
  override dispatchEvent(event: never): boolean {
    return super.dispatchEvent(event)
  }

  /**
   * Poll status  for colab and other things that don't support websockets.
   */
  #pollQueue() {
    setInterval(async () => {
      try {

        const resp = await this.fetchApi('/prompt')
        const status = (await resp.json()) as StatusWsMessageStatus
        this.dispatchCustomEvent('status', status)
      } catch (error) {
        this.dispatchCustomEvent('status', null)
      }
    }, 1000)
  }

  /**
   * Creates and connects a WebSocket for realtime updates
   * @param {boolean} isReconnect If the socket is connection is a reconnect attempt
   */
  async #createSocket(isReconnect?: boolean) {
    if (this.socket) {
      return
    }
    
    let opened = false
    let existingSession = window.name
    if (existingSession) {
      existingSession = '?clientId=' + existingSession
    }
    console.log('Creating websocket')
    const ws = await this.apiURL('')
    const socketHost = ws.replace('https://', '').replace('http://', '')
    const protocol = ws.startsWith('https://') ? 'wss' : 'ws'
    console.log(`${protocol}://${socketHost}/ws${existingSession}`)
    this.socket = new WebSocket(
      `${protocol}://${socketHost}/ws${existingSession}`
    )
    this.socket.binaryType = 'arraybuffer'

    this.socket.addEventListener('open', () => {
      opened = true
      if (isReconnect) {
        this.dispatchCustomEvent('reconnected')
      }
    })

    this.socket.addEventListener('error', () => {
      if (this.socket) this.socket.close()
      if (!isReconnect && !opened) {
        this.#pollQueue()
      }
    })

    this.socket.addEventListener('close', () => {
      setTimeout(() => {
        this.socket = null
        // this.#createSocket(true)
      }, 300)
      if (opened) {
        this.dispatchCustomEvent('status', null)
        this.dispatchCustomEvent('reconnecting')
      }
    })

    this.socket.addEventListener('message', (event) => {
      try {
        console.log('WEBSOCKET EVENT', event)
        if (event.data instanceof ArrayBuffer) {
          const view = new DataView(event.data)
          const eventType = view.getUint32(0)

          let imageMime
          switch (eventType) {
            case 3:
              const decoder = new TextDecoder()
              const data = event.data.slice(4)
              const nodeIdLength = view.getUint32(4)
              this.dispatchCustomEvent('progress_text', {
                nodeId: decoder.decode(data.slice(4, 4 + nodeIdLength)),
                text: decoder.decode(data.slice(4 + nodeIdLength))
              })
              break
            case 1:
              const imageType = view.getUint32(4)
              const imageData = event.data.slice(8)
              console.log({imageType, imageData})
              switch (imageType) {
                case 2:
                  imageMime = 'image/png'
                  break
                case 1:
                default:
                  imageMime = 'image/jpeg'
                  break
              }
              const imageBlob = new Blob([imageData], {
                type: imageMime
              })
              this.dispatchCustomEvent('b_preview', imageBlob)
              break
            default:
              throw new Error(
                `Unknown binary websocket message of type ${eventType}`
              )
          }
        } else {
          const msg = JSON.parse(event.data) as ApiMessageUnion
          switch (msg.type) {
            case 'status':
              if (msg.data.sid) {
                const clientId = msg.data.sid
                this.clientId = clientId
                window.name = clientId // use window name so it isnt reused when duplicating tabs
                sessionStorage.setItem('clientId', clientId) // store in session storage so duplicate tab can load correct workflow
              }
              this.dispatchCustomEvent('status', msg.data.status ?? null)
              break
            case 'executing':
              this.dispatchCustomEvent(
                'executing',
                msg.data.display_node || msg.data.node
              )
              break
            case 'execution_start':
            case 'execution_error':
            case 'execution_interrupted':
            case 'execution_cached':
            case 'execution_success':
            case 'progress':
            case 'executed':
            case 'graphChanged':
            case 'promptQueued':
            case 'logs':
            case 'b_preview':
              this.dispatchCustomEvent(msg.type, msg.data)
              break
            default:
              if (this.#registered.has(msg.type)) {
                // Fallback for custom types - calls super direct.
                super.dispatchEvent(
                  new CustomEvent(msg.type, { detail: msg.data })
                )
              } else if (!this.reportedUnknownMessageTypes.has(msg.type)) {
                this.reportedUnknownMessageTypes.add(msg.type)
                throw new Error(`Unknown message type ${msg.type}`)
              }
          }
        }
      } catch (error) {
        console.warn('Unhandled message:', event.data, error)
      }
    })
  }

  /**
   * Initialises sockets and realtime updates
   */
  init() {
    this.#createSocket()
  }

  /**
   * Gets a list of extension urls
   */
  async getExtensions(): Promise<ExtensionsResponse> {
    const resp = await this.fetchApi('/extensions', [], { cache: 'no-store' })
    return await resp.json()
  }

  /**
   * Gets the available workflow templates from custom nodes.
   * @returns A map of custom_node names and associated template workflow names.
   */
  async getWorkflowTemplates(): Promise<{
    [customNodesName: string]: string[]
  }> {
    const res = await this.fetchApi('/workflow_templates')
    return await res.json()
  }

  /**
   * Gets the index of core workflow templates.
   */
  async getCoreWorkflowTemplates(): Promise<WorkflowTemplates[]> {
    const res = await axios.get(this.fileURL('/templates/index.json'))
    const contentType = res.headers['content-type']
    return contentType?.includes('application/json') ? res.data : []
  }

  /**
   * Gets a list of embedding names
   */
  async getEmbeddings(): Promise<EmbeddingsResponse> {
    const resp = await this.fetchApi('/embeddings', [], { cache: 'no-store' })
    return await resp.json()
  }

  /**
   * Loads node object definitions for the graph
   * @returns The node definitions
   */
  // async getNodeDefs({ validate = false }: { validate?: boolean } = {}): Promise<
  //   Record<string, ComfyNodeDef>
  // > {
  //   if (!window.__COMFYAPP || !window.__COMFYAPP.serializedNodesDefinition)
  //     return {}
  //   const objectInfoUnsafe = JSON.parse(
  //     window.__COMFYAPP.serializedNodesDefinition
  //   )

  //   if (!validate) {
  //     return objectInfoUnsafe
  //   }
  //   // Validate node definitions against zod schema. (slow)
  //   const objectInfo: Record<string, ComfyNodeDef> = {}
  //   for (const key in objectInfoUnsafe) {
  //     const validatedDef = validateComfyNodeDef(
  //       objectInfoUnsafe[key],
  //       /* onError=*/ (errorMessage: string) => {
  //         console.warn(
  //           `Skipping invalid node definition: ${key}. See debug log for more information.`
  //         )
  //         console.debug(errorMessage)
  //       }
  //     )
  //     if (validatedDef !== null) {
  //       objectInfo[key] = validatedDef
  //     }
  //   }
  //   return objectInfo
  // }

  async getNodeDefs({ validate = false }: { validate?: boolean } = {}): Promise<
  Record<string, ComfyNodeDef>
> {
  const resp = await this.fetchApi('/object_info', { cache: 'no-store' })
  const objectInfoUnsafe = await resp.json()
  if (!validate) {
    return objectInfoUnsafe
  }
  // Validate node definitions against zod schema. (slow)
  const objectInfo: Record<string, ComfyNodeDef> = {}
  for (const key in objectInfoUnsafe) {
    const validatedDef = validateComfyNodeDef(
      objectInfoUnsafe[key],
      /* onError=*/ (errorMessage: string) => {
        console.warn(
          `Skipping invalid node definition: ${key}. See debug log for more information.`
        )
        console.debug(errorMessage)
      }
    )
    if (validatedDef !== null) {
      objectInfo[key] = validatedDef
    }
  }
  return objectInfo
}

  /**
   * Queues a prompt to be executed
   * @param {number} number The index at which to queue the prompt, passing -1 will insert the prompt at the front of the queue
   * @param {object} prompt The prompt data to queue
   * @throws {PromptExecutionError} If the prompt fails to execute
   */
  async queuePrompt(
    number: number,
    data: { output: ComfyApiWorkflow; workflow: ComfyWorkflowJSON }
  ): Promise<PromptResponse> {
    const { output: prompt, workflow } = data

    const body: QueuePromptRequestBody = {
      client_id: this.clientId ?? '', // TODO: Unify clientId access
      prompt,
      extra_data: {
        auth_token_comfy_org: this.authToken,
        api_key_comfy_org: this.apiKey,
        extra_pnginfo: { workflow }
      }
    }

    if (number === -1) {
      body.front = true
    } else if (number != 0) {
      body.number = number
    }

    const res = await this.fetchApi(
      '/prompt',
      {},
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    )
    console.log({config})
    if (res.status !== 200) {
      throw new PromptExecutionError(await res.json())
    }

    return await res.json()
  }

  /**
   * Gets a list of model folder keys (eg ['checkpoints', 'loras', ...])
   * @returns The list of model folder keys
   */
  async getModelFolders(): Promise<{ name: string; folders: string[] }[]> {
    const res = await this.fetchApi(`/experiment/models`)
    if (res.status === 404) {
      return []
    }
    const folderBlacklist = ['configs', 'custom_nodes']
    return (await res.json()).filter(
      (folder: string) => !folderBlacklist.includes(folder)
    )
  }

  /**
   * Gets a list of models in the specified folder
   * @param {string} folder The folder to list models from, such as 'checkpoints'
   * @returns The list of model filenames within the specified folder
   */
  async getModels(
    folder: string
  ): Promise<{ name: string; pathIndex: number }[]> {
    const res = await this.fetchApi(`/experiment/models/${folder}`)
    if (res.status === 404) {
      return []
    }
    return await res.json()
  }

  /**
   * Gets the metadata for a model
   * @param {string} folder The folder containing the model
   * @param {string} model The model to get metadata for
   * @returns The metadata for the model
   */
  async viewMetadata(folder: string, model: string) {
    const res = await this.fetchApi(
      `/view_metadata/${folder}?filename=${encodeURIComponent(model)}`
    )
    const rawResponse = await res.text()
    if (!rawResponse) {
      return null
    }
    try {
      return JSON.parse(rawResponse)
    } catch (error) {
      console.error(
        'Error viewing metadata',
        res.status,
        res.statusText,
        rawResponse,
        error
      )
      return null
    }
  }

  /**
   * Loads a list of items (queue or history)
   * @param {string} type The type of items to load, queue or history
   * @returns The items of the specified type grouped by their status
   */
  async getItems(type: 'queue' | 'history') {
    if (type === 'queue') {
      return this.getQueue()
    }
    return this.getHistory()
  }

  /**
   * Gets the current state of the queue
   * @returns The currently running and queued items
   */
  async getQueue(): Promise<{
    Running: RunningTaskItem[]
    Pending: PendingTaskItem[]
  }> {
    try {
      // Playbook edits to mock API calls - empty data objects.
      const res = await this.fetchApi('/queue', {queue_running: [], queue_pending: []})
      const data = await res.json()
      return {
        // Running action uses a different endpoint for cancelling
        Running: data.queue_running.map((prompt: Record<number, any>) => ({
          taskType: 'Running',
          prompt,
          remove: { name: 'Cancel', cb: () => api.interrupt() }
        })),
        Pending: data.queue_pending.map((prompt: Record<number, any>) => ({
          taskType: 'Pending',
          prompt
        }))
      }
    } catch (error) {
      console.error(error)
      return { Running: [], Pending: [] }
    }
  }

  /**
   * Gets the prompt execution history
   * @returns Prompt history including node outputs
   */
  async getHistory(
    max_items: number = 200
  ): Promise<{ History: HistoryTaskItem[] }> {
    try {
      // Playbook edits to mock API calls - empty data to return {}.
      const res = await this.fetchApi(`/history?max_items=${max_items}`, {})
      const json: Promise<HistoryTaskItem[]> = await res.json()
      return {
        History: Object.values(json).map((item) => ({
          ...item,
          taskType: 'History'
        }))
      }
    } catch (error) {
      console.error(error)
      return { History: [] }
    }
  }

  /**
   * Gets system & device stats
   * @returns System stats such as python version, OS, per device info
   */
  async getSystemStats(): Promise<SystemStats> {
    const res = await this.fetchApi('/system_stats')
    return await res.json()
  }

  /**
   * Sends a POST request to the API
   * @param {*} type The endpoint to post to
   * @param {*} body Optional POST data
   */
  async #postItem(type: string, body: any) {
    try {
      await this.fetchApi(
        '/' + type,
        {},
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: body ? JSON.stringify(body) : undefined
        }
      )
    } catch (error) {
      console.error(error)
    }
  }

  /**
   * Deletes an item from the specified list
   * @param {string} type The type of item to delete, queue or history
   * @param {number} id The id of the item to delete
   */
  async deleteItem(type: string, id: string) {
    await this.#postItem(type, { delete: [id] })
  }

  /**
   * Clears the specified list
   * @param {string} type The type of list to clear, queue or history
   */
  async clearItems(type: string) {
    await this.#postItem(type, { clear: true })
  }

  /**
   * Interrupts the execution of the running prompt
   */
  async interrupt() {
    await this.#postItem('interrupt', null)
  }

  /**
   * Gets user configuration data and where data should be stored
   */
  async getUserConfig(): Promise<User> {
    const response = await this.fetchApi('/users', {
      storage: 'server',
      migrated: true
    })
    const json = await response.json()
    return json
  }

  /**
   * Creates a new user
   * @param { string } username
   * @returns The fetch response
   */
  createUser(username: string) {
    return this.fetchApi(
      '/users',
      {},
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username })
      }
    )
  }

  /**
   * Gets all setting values for the current user
   * @returns { Promise<string, unknown> } A dictionary of id -> value
   */
  async getSettings(): Promise<Settings> {
    // Playbook Edits to mock API calls - empty data to return {}.
    const resp = await this.fetchApi('/settings', {})

    if (resp.status == 401) {
      throw new UnauthorizedError(resp.statusText)
    }
    return await resp.json()
  }

  /**
   * Gets a setting for the current user
   * @param { string } id The id of the setting to fetch
   * @returns { Promise<unknown> } The setting value
   */
  async getSetting(id: keyof Settings): Promise<Settings[keyof Settings]> {
    return (await this.fetchApi(`/settings/${encodeURIComponent(id)}`)).json()
  }

  /**
   * Stores a dictionary of settings for the current user
   */
  async storeSettings(settings: Settings) {
    return this.fetchApi(`/settings`, {
      method: 'POST',
      body: JSON.stringify(settings)
    })
  }

  /**
   * Stores a setting for the current user
   */
  async storeSetting(id: keyof Settings, value: Settings[keyof Settings]) {
    return this.fetchApi(`/settings/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(value)
    })
  }

  /**
   * Gets a user data file for the current user
   */
  async getUserData(file: string, options?: RequestInit) {
    return this.fetchApi(`/userdata/${encodeURIComponent(file)}`, [], options)
  }

  /**
   * Stores a user data file for the current user
   * @param { string } file The name of the userdata file to save
   * @param { unknown } data The data to save to the file
   * @param { RequestInit & { stringify?: boolean, throwOnError?: boolean } } [options]
   * @returns { Promise<Response> }
   */
  async storeUserData(
    file: string,
    data: any,
    options: RequestInit & {
      overwrite?: boolean
      stringify?: boolean
      throwOnError?: boolean
      full_info?: boolean
    } = {
      overwrite: true,
      stringify: true,
      throwOnError: true,
      full_info: false
    }
  ): Promise<Response> {
    const resp = await this.fetchApi(
      `/userdata/${encodeURIComponent(file)}?overwrite=${options.overwrite}&full_info=${options.full_info}`,
      {
        method: 'POST',
        body: options?.stringify ? JSON.stringify(data) : data,
        ...options
      }
    )
    if (resp.status !== 200 && options.throwOnError !== false) {
      throw new Error(
        `Error storing user data file '${file}': ${resp.status} ${(await resp).statusText}`
      )
    }

    return resp
  }

  /**
   * Deletes a user data file for the current user
   * @param { string } file The name of the userdata file to delete
   */
  async deleteUserData(file: string) {
    const resp = await this.fetchApi(
      `/userdata/${encodeURIComponent(file)}`,
      {},
      {
        method: 'DELETE'
      }
    )
    return resp
  }

  /**
   * Move a user data file for the current user
   * @param { string } source The userdata file to move
   * @param { string } dest The destination for the file
   */
  async moveUserData(
    source: string,
    dest: string,
    options = { overwrite: false }
  ) {
    const resp = await this.fetchApi(
      `/userdata/${encodeURIComponent(source)}/move/${encodeURIComponent(dest)}?overwrite=${options?.overwrite}`,
      {},
      {
        method: 'POST'
      }
    )
    return resp
  }

  async listUserDataFullInfo(dir: string): Promise<UserDataFullInfo[]> {
    // Playbook Edits to mock API calls - empty data to return [].
    const resp = await this.fetchApi(
      `/userdata?dir=${encodeURIComponent(dir)}&recurse=true&split=false&full_info=true`, []
    )
    if (resp.status === 404) return []
    if (resp.status !== 200) {
      throw new Error(
        `Error getting user data list '${dir}': ${resp.status} ${resp.statusText}`
      )
    }
    return resp.json()
  }

  async getLogs(): Promise<string> {
    return (await axios.get(this.internalURL('/logs'))).data
  }

  async getRawLogs(): Promise<LogsRawResponse> {
    return (await axios.get(this.internalURL('/logs/raw'))).data
  }

  async subscribeLogs(enabled: boolean): Promise<void> {
    return await axios.patch(this.internalURL('/logs/subscribe'), {
      enabled,
      clientId: this.clientId
    })
  }

  async getFolderPaths(): Promise<Record<string, string[]>> {
    return (await axios.get(this.internalURL('/folder_paths'))).data
  }

  /**
   * Gets the custom nodes i18n data from the server.
   *
   * @returns The custom nodes i18n data
   */
  async getCustomNodesI18n(): Promise<Record<string, any>> {
    // Playbook Edits to mock API calls.
    return await this.fetchApi('/i18n', {})
    // return (await axios.get(this.apiURL('/i18n'))).data
  }
}

export const api = new ComfyApi()
