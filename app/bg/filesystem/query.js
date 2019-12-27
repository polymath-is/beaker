import datDns from '../dat/dns'
import { joinPath } from '../../lib/strings'
import { chunkMapAsync } from '../../lib/functions'
import { DAT_HASH_REGEX } from '../../lib/const'

// typedefs
// =

/**
 * @typedef {import('../dat/daemon').DaemonDatArchive} DaemonDatArchive
 * 
 * @typedef {Object} FSQueryOpts
 * @prop {string|string[]} path
 * @prop {string} [type]
 * @prop {string} [mount]
 * @prop {Object} [metadata]
 * @prop {string} [sort] - 'name', 'ctime', 'mtime'
 * @prop {boolean} [reverse]
 * @prop {number} [limit]
 * @prop {number} [offset]
 * 
 * @typedef {Object} Stat
 * @prop {number} mode
 * @prop {number} size
 * @prop {number} offset
 * @prop {number} blocks
 * @prop {Date} atime
 * @prop {Date} mtime
 * @prop {Date} ctime
 * @prop {Object} [mount]
 * @prop {string} [mount.key]
 * @prop {string} linkname
 *  
 * @typedef {Object} FSQueryResult
 * @prop {string} type
 * @prop {string} path
 * @prop {string} url
 * @prop {Stat} stat
 * @prop {string} drive
 * @prop {string} [mount]
 */

// exported api
// =

// navigator.filesystem.query({type: 'mount', path: ['/profile', '/profile/follows/*', '/profile/follows/*/follows/*']})
// => [{type: 'mount', path: '/profile', stat, mount, drive}, {type: 'mount', path: '/profile/friend/bob', stat, mount, drive}, ...]

// navigator.filesystem.query({type: 'mount', mount: url, path: ['/profile/follows/*', '/profile/follows/*/follows/*']})
// => [{type: 'mount', path: '/profile/friend/bob', stat, mount, drive}, ...]

// navigator.filesystem.query({type: 'file', metadata: {href: url}, path: ['/profile/comments', '/profile/follows/*/comments', '/profile/follows/*/follows/*/comments']})
// => [{type: 'folder', path: '/profile/comments/foo.txt', stat, drive}]

/**
 * @param {DaemonDatArchive} root
 * @param {FSQueryOpts} opts
 * @returns {Promise<FSQueryResult[]>}
 */
export async function query (root, opts) {
  var parentDriveStatCache = {}

  // validate opts
  if (!opts || !opts.path) throw new Error('The `path` parameter is required')
  if (!(typeof opts.path === 'string' || (Array.isArray(opts.path) && opts.path.every(v => typeof v === 'string')))) {
    throw new Error('The `path` parameter must be a string or array of strings')
  }
  if (opts.type && typeof opts.type !== 'string') {
    throw new Error('The `type` parameter must be a string')
  }
  if (opts.mount && typeof opts.mount !== 'string') {
    throw new Error('The `mount` parameter must be a string')
  }
  if (opts.metadata && typeof opts.metadata !== 'object') {
    throw new Error('The `metadata` parameter must be an object')
  }

  // massage opts
  if (opts.mount) {
    opts.mount = await datDns.resolveName(opts.mount)
    opts.mount = DAT_HASH_REGEX.exec(opts.mount)[0]
  }

  // drive lookup tools & cache
  async function getParentDriveInfo (path) {
    var pathParts = path.split('/').filter(Boolean).slice(0, -1)
    while (pathParts.length > 0) {
      let mountPath = pathParts.join('/')
      let drive
  
      // check fs
      let st = parentDriveStatCache[mountPath]
      if (!st) {
        parentDriveStatCache[mountPath] = st = root.pda.stat(mountPath).catch(e => null)
      }
      st = await st
      if (st && st.mount && st.mount.key) {
        drive = `dat://${st.mount.key.toString('hex')}`
      }

      if (drive) {
        return {drive, url: joinPath(drive, path.slice(mountPath.length + 1))}
      }

      pathParts.pop()
    }
    return {drive: `dat://${root.key.toString('hex')}`, url: joinPath(root.url, path)}
  }

  // iterate all matching paths and match against the query
  var candidates = await expandPaths(root, opts.path)
  var results = []
  await chunkMapAsync(candidates, 100, async (path) => {
    let stat
    try {
      stat = await root.pda.stat(path)
    } catch (e) {
      // dne, skip
      return
    }

    var type = 'file'
    if (stat.mount && stat.mount.key) type = 'mount'
    else if (stat.isDirectory()) type = 'directory'

    if (opts.type && type !== opts.type) return
    if (opts.mount && (type !== 'mount' || stat.mount.key.toString('hex') !== opts.mount)) return
    if (opts.metadata) {
      let metaMatch = true
      for (let k in opts.metadata) {
        if (stat.metadata[k] !== opts.metadata[k]) {
          metaMatch = false
          break
        }
      }
      if (!metaMatch) return
    }

    var {drive, url} = await getParentDriveInfo(path)
    results.push({
      type,
      path,
      url,
      stat,
      drive,
      mount: type === 'mount' ? `dat://${stat.mount.key.toString('hex')}` : undefined
    })
  })

  if (opts.sort === 'name') {
    results.sort((a, b) => (opts.reverse) ? b.path.toLowerCase().localeCompare(a.path.toLowerCase()) : a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
  } else if (opts.sort === 'mtime') {
    results.sort((a, b) => (opts.reverse) ? b.stat.mtime - a.stat.mtime : a.stat.mtime - b.stat.mtime)
  } else if (opts.sort === 'ctime') {
    results.sort((a, b) => (opts.reverse) ? b.stat.ctime - a.stat.ctime : a.stat.ctime - b.stat.ctime)
  }

  if (opts.offset && opts.limit) results = results.slice(opts.offset, opts.offset + opts.limit)
  else if (opts.offset) results = results.slice(opts.offset)
  else if (opts.limit) results = results.slice(0, opts.limit)

  return results
}

// internal
// =

async function expandPaths (root, patterns) {
  var paths = []
  patterns = Array.isArray(patterns) ? patterns : [patterns]
  await Promise.all(patterns.map(async (pattern) => {
    // parse the pattern into a set of ops
    let acc = []
    let ops = []
    for (let part of pattern.split('/')) {
      if (part.includes('*')) {
        ops.push(['push', acc.filter(Boolean).join('/')])
        ops.push(['match', part])
        acc = []
      } else {
        acc.push(part)
      }
    }
    if (acc.length) ops.push(['push', acc.join('/')])

    // run the ops to assemble a list of matching paths
    var workingPaths = ['/']
    for (let op of ops) {
      let newWorkingPaths = []
      if (op[0] === 'push') {
        // add the given segment to all working paths
        newWorkingPaths = workingPaths.map(v => joinPath(v, op[1]))
      } else if (op[0] === 'match') {
        // compile a glob-matching regex from the segment
        var re = new RegExp(`^${op[1].replace(/\*/g, '[^/]*')}$`, 'i')
        
        // read the files at each working path
        for (let workingPath of workingPaths) {
          for (let name of await root.pda.readdir(workingPath).catch(e => [])) {
            // add matching names to the working path
            if (re.test(name)) {
              newWorkingPaths.push(joinPath(workingPath, name))
            }
          }
        }
      }
      workingPaths = newWorkingPaths
    }
    
    // emit the results
    for (let result of workingPaths) {
      paths.push(result)
    }
  }))
  return paths
}

// TODO!!
// put these tests somewhere!!
// const _get = require('lodash.get')
// const _isEqual = require('lodash.isequal')
// const assert = require('assert')
// const toArray = require('async-iterator-to-array')

// const RootMockPaths = {
//   foo: {
//     bar: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     },
//     bar2: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     },
//     bar3: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     }
//   },
//   foo2: {
//     bar: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     },
//     bar2: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     },
//     bar3: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     }
//   },
//   foo3: {
//     bar: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     },
//     bar2: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     },
//     bar3: {
//       baz: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz2: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       },
//       baz3: {
//         biz: {},
//         biz2: {},
//         biz3: {}
//       }
//     }
//   }
// }

// const RootMock = {
//   async readdir (path) {
//     path = path.replace(/\./g, '')
//     path = path.split('/').filter(Boolean).join('.')
//     if (!path) return Object.keys(RootMockPaths)
//     return Object.keys(_get(RootMockPaths, path) || {})
//   }
// }

// async function test () {
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/'])), ['/']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/foo'])), ['/foo']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/*'])), ['/foo', '/foo2', '/foo3']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/*oo'])), ['/foo']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/*oo*'])), ['/foo', '/foo2', '/foo3']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/*/bar'])), ['/foo/bar', '/foo2/bar', '/foo3/bar']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/f*/bar'])), ['/foo/bar', '/foo2/bar', '/foo3/bar']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/foo/*'])), ['/foo/bar', '/foo/bar2', '/foo/bar3']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/*oo/*'])), ['/foo/bar', '/foo/bar2', '/foo/bar3']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/foo/*/baz'])), ['/foo/bar/baz', '/foo/bar2/baz', '/foo/bar3/baz']))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/foo/*/baz/*'])), [
//     '/foo/bar/baz/biz',
//     '/foo/bar/baz/biz2',
//     '/foo/bar/baz/biz3',
//     '/foo/bar2/baz/biz',
//     '/foo/bar2/baz/biz2',
//     '/foo/bar2/baz/biz3',
//     '/foo/bar3/baz/biz',
//     '/foo/bar3/baz/biz2',
//     '/foo/bar3/baz/biz3'
//   ]))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/foo/*/*/biz'])), [
//     '/foo/bar/baz/biz',
//     '/foo/bar/baz2/biz',
//     '/foo/bar/baz3/biz',
//     '/foo/bar2/baz/biz',
//     '/foo/bar2/baz2/biz',
//     '/foo/bar2/baz3/biz',
//     '/foo/bar3/baz/biz',
//     '/foo/bar3/baz2/biz',
//     '/foo/bar3/baz3/biz'
//   ]))
//   assert(_isEqual(await toArray(expandPaths(RootMock, ['/', '/foo', '/*/bar'])), ['/', '/foo', '/foo/bar', '/foo2/bar', '/foo3/bar']))
//   console.log('done')
// }

// test()
