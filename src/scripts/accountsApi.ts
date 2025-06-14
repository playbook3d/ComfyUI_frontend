export class AccountsApi {
  url: string;
  apiKey: string;
  headers: Record<string, any>
  constructor(url: string, apiKey: string, ) {
    this.url = url;
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    }
  }
  fetch(url: string, options: RequestInit) {
    let _headers = {
      ...this.headers,
    } as Record<string, any>;
    if (options.method === 'POST') {
      _headers['Content-Type'] = 'application/json'
    }
    if (options.headers) {
      _headers = {
        ...this.headers,
        ...options.headers
      }
    }
    return fetch(url, {headers: _headers})
  }

  getInfo(teamId: string) {
    // return new Promise((resolve, _) => {
    //   resolve(new Response(JSON.stringify({
    //       app_url: "https://playbook--4566232c-bd6a-4ccf-b5b1-b7ce9a7809e0-n-ui-dev.modal.run",
    //       user_jwt: "jwt",
    //       workflow_id: "workflow_id"
    //     })))
    // });
    return this.fetch(`${this.url}/v2/get-native/${teamId}`, {
      method: 'GET',
    })
  }

  getWorkflow(workflow_id: string, jwt: string) {
    return this.fetch(`${this.url}/v2/workflow/${workflow_id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${jwt}`
      },
    })
  }
  createRun(workflow_id: string, jwt: string) {
    return this.fetch(`${this.url}/v2/native/run/${workflow_id}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        workflow_id,
        jwt,
      }),
      method: 'POST',
    })
  }
}