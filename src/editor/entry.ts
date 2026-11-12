// The custom editor entry Orca loads in a generated page: sync the document, build the UI.
import { startSession } from './sync'
import { createEditor } from './ui'

const doc = await startSession()
createEditor(doc)
