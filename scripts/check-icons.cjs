// Run with Electron, not Node: this checks the real OS image decoder and Tray.
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { app, BrowserWindow, nativeImage, Tray } = require('electron')
const dir = join(__dirname, '../assets/icons')

app.whenReady().then(() => {
  let win
  let tray
  try {
    for (const name of ['app-icon.png', 'app-icon.ico', 'tray-dark.png', 'tray-light.png', 'tray-dark.ico', 'tray-light.ico']) {
      const icon = nativeImage.createFromPath(join(dir, name))
      assert(!icon.isEmpty(), `${name} failed to decode`)
      assert(icon.getSize().width >= 16, `${name} is too small`)
    }
    const extension = process.platform === 'win32' ? 'ico' : 'png'
    win = new BrowserWindow({ show: false, icon: join(dir, `app-icon.${extension}`) })
    tray = new Tray(join(dir, `tray-dark.${extension}`))
    tray.setImage(join(dir, `tray-light.${extension}`))
    tray.setToolTip('ARMS icon verification')
    const source = nativeImage.createFromPath(join(dir, 'tray-dark.png'))
    const template = source.resize({ width: 16, height: 16 })
    template.addRepresentation({ scaleFactor: 2, buffer: source.toPNG() })
    assert.deepEqual(template.getScaleFactors().sort(), [1, 2])
    console.log('PASS: all six icon assets decode; window and both tray icons load; 1x/2x representations exist.')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    tray?.destroy()
    win?.destroy()
    app.quit()
  }
})
