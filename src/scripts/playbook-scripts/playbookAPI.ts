export async function getNodeDefinitionsData() {
  fetch('../node_definition.json')
    .then((response) => {
      if (!response.ok) {
        throw new Error('Network response was not ok')
      }
      return response.json()
    })
    .catch((error) => {
      console.error(
        'There has been a problem with your fetch operation:',
        error
      )
    })
}
