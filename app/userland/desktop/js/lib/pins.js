
export async function load () {
  try {
    var str = await navigator.filesystem.readFile('/system/desktop.json')
    var obj = JSON.parse(str)
    return obj.pins
  } catch (e) {
    console.log('Failed to load pins, falling back to defaults', e)
    return defaults()
  }
}

export async function save (pins) {
  await navigator.filesystem.writeFile('/system/desktop.json', JSON.stringify({
    type: 'desktop',
    pins
  }, null, 2))
}

// internal methods
// =

function defaults () {
  return [
    // TODO
  ]
}