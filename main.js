
const core = require("@actions/core")
const exec = require("@actions/exec")
const io = require("@actions/io")
const tc = require("@actions/tool-cache")
const fsp = require("fs").promises
const semver = require("semver")

const path = require("path")

const BUILD_PREFIX = ".build-luarocks"

const LUA_PREFIX = ".lua" // default location for existing Lua installation
const LUAROCKS_PREFIX = ".luarocks" // default location for LuaRocks installation
const PE_PARSER_VERSION = "0.6" // version of https://github.com/Tieske/pe-parser

const isWindows = () => (process.platform || "").startsWith("win32")

async function installWindows(luaRocksVersion, tempBuildPath, luaRocksInstallPath, luaPath) {
  const binaryZip = await tc.downloadTool(`https://luarocks.org/releases/luarocks-${luaRocksVersion}-windows-64.zip`)
  await tc.extractZip(binaryZip, tempBuildPath)

  const srcDir = path.join(tempBuildPath, `luarocks-${luaRocksVersion}-windows-64`)
  const dstDir = path.join(luaRocksInstallPath, "bin")
  const luaExe = path.join(luaPath, "bin", "lua.exe")

  await io.mkdirP(dstDir)

  for (let file of ["luarocks.exe", "luarocks-admin.exe"]) {
    await fsp.copyFile(path.join(srcDir, file), path.join(dstDir, file))
  }

  let luaVersion = ""
  await exec.exec(`lua -e "print(_VERSION:sub(5))"`, undefined, {
    listeners: {
      stdout: (data) => {
        luaVersion += data.toString()
      }
    }
  })

  await exec.exec(`luarocks config lua_version ${luaVersion}`, undefined, {})

  await exec.exec(`luarocks config LUA_LIBDIR ${luaPath}/lib`, undefined, {})

  if (!process.env["VCINSTALLDIR"]) {
    if (semver.lt(luaRocksVersion, "3.9.2")) {
      await exec.exec(`luarocks config variables.CC "x86_64-w64-mingw32-gcc"`, undefined, {})
      await exec.exec(`luarocks config variables.LD "x86_64-w64-mingw32-gcc"`, undefined, {})
    }

    const peParserTarball = await tc.downloadTool(`https://github.com/Tieske/pe-parser/archive/refs/tags/version_${PE_PARSER_VERSION}.tar.gz`)
    await tc.extractTar(peParserTarball, tempBuildPath)
    
    const peParser = path.join(tempBuildPath, `pe-parser-version_${PE_PARSER_VERSION}`, "src", "pe-parser.lua")
  
    let msvcrt = ""
    await exec.exec(`lua -e "local pe = assert(loadfile([[${peParser}]]))(); local rt, _ = pe.msvcrt([[${luaExe}]]); print(rt or 'nil')"`, undefined, {
      listeners: {
        stdout: (data) => {
          msvcrt += data.toString()
          if (msvcrt === "nil") {
            msvcrt = ""
          }
          else if (msvcrt === "MSVCRT") {
            msvcrt = "m"
          }
        }
      }
    })
  
    if (msvcrt != "") {
      await exec.exec(`luarocks config variables.MSVCRT "${msvcrt}"`, undefined, {})
    }
  }
}

async function installUnix(luaRocksVersion, tempBuildPath, luaRocksInstallPath, luaPath) {
  let sourceTar
  if (luaRocksVersion.startsWith("@")) {
    luaRocksVersion = luaRocksVersion.substring(1) // remove the '@' prefix
    if (!luaRocksVersion) {
      luaRocksVersion = "master" // default to master branch if no version is specified
    }
    sourceTar = await tc.downloadTool(`https://github.com/luarocks/luarocks/archive/${luaRocksVersion}.tar.gz`)
  } else {
    sourceTar = await tc.downloadTool(`https://luarocks.org/releases/luarocks-${luaRocksVersion}.tar.gz`)
  }

  await tc.extractTar(sourceTar, path.join(tempBuildPath))

  const luaRocksExtractPath = path.join(tempBuildPath, `luarocks-${luaRocksVersion}`)

  const configureArgs = [
    `--with-lua="${luaPath}"`,
    `--prefix="${luaRocksInstallPath}"`
  ]

  await exec.exec(`./configure ${configureArgs.join(" ")}`, undefined, {
    cwd: luaRocksExtractPath
  })

  await exec.exec("make", undefined, {
    cwd: luaRocksExtractPath
  })

  // NOTE: make build step is only necessary for luarocks 2.x
  if (luaRocksVersion.match(/^2\./)) {
    await exec.exec("make build", undefined, {
      cwd: luaRocksExtractPath
    })
  }

  await exec.exec("make install", undefined, {
    cwd: luaRocksExtractPath
  })
}

async function main() {
  const luaRocksVersion = core.getInput('luaRocksVersion', { required: true })

  const luaRocksInstallPath = path.join(process.cwd(), LUAROCKS_PREFIX)

  const tempBuildPath = path.join(process.env["RUNNER_TEMP"], BUILD_PREFIX)
  await io.mkdirP(tempBuildPath)

  let luaPath = core.getInput("withLuaPath")
  if (!luaPath) {
    // NOTE: this is the default install path provided by gh-actions-lua
    luaPath = path.join(process.cwd(), LUA_PREFIX)
  }

  core.addPath(path.join(luaRocksInstallPath, "bin"));

  if (isWindows()) {
    await installWindows(luaRocksVersion, tempBuildPath, luaRocksInstallPath, luaPath);
  } else {
    await installUnix(luaRocksVersion, tempBuildPath, luaRocksInstallPath, luaPath);
  }

  // Update environment to use luarocks directly
  let lrBin = ""

  await exec.exec("luarocks path --lr-bin", undefined, {
    listeners: {
      stdout: (data) => {
        lrBin += data.toString()
      }
    }
  })

  await exec.exec("luarocks path --lr-bin", undefined, {
    listeners: {
      stdout: (data) => {
        lrBin += data.toString()
      }
    }
  })

  if (lrBin != "") {
    core.addPath(lrBin.trim());
  }

  let lrPath = ""

  await exec.exec("luarocks path --lr-path", undefined, {
    listeners: {
      stdout: (data) => {
        lrPath += data.toString()
      }
    }
  })

  lrPath = lrPath.trim()

  let lrCpath = ""

  await exec.exec("luarocks path --lr-cpath", undefined, {
    listeners: {
      stdout: (data) => {
        lrCpath += data.toString()
      }
    }
  })

  lrCpath = lrCpath.trim()

  if (lrPath != "") {
    core.exportVariable("LUA_PATH", ";;" + lrPath)
  }

  if (lrCpath != "") {
    core.exportVariable("LUA_CPATH", ";;" + lrCpath)
  }
}

main().catch(err => {
  core.setFailed(`Failed to install LuaRocks: ${err}`);
})

