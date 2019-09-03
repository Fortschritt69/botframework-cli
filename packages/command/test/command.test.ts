import {Command} from '../src/command'
import {CLIError, ExitError} from '@oclif/errors' 
import {expect, fancy} from 'fancy-test'
import ReadPipedStdin from '../src/readpipeddata'
const assert = require('assert');

describe('command', () => {
  fancy
  .stderr()
  .do(async () => {
    const thrownError = new Error('failure')
    class Test extends Command {
        async run() {
          throw new Error('failure')
        }
      }

    return Test.run([])
  })
  .do(output => expect(output.stderr).to.equal('Unknown error during execution. Please file an issue on https://github.com/microsoft/botframework-cli/issues\nfailure\n'))
  .it('errors out')

  fancy
  .stderr()
  .do(async () => {
    const thrownError = new CLIError('failure')
    class Test extends Command {
        async run() {
          throw new CLIError('failure')
        }
      }

    return Test.run([])
  })
  .do(output => expect(output.stderr).to.equal('failure\n'))
  .it('Exits with error')

  fancy
  .stderr()
  .do(async () => {
    class Test extends Command {
        async run() {
            this.error('message')
        }
      }

    return Test.run([])
  })
  .do(output => expect(output.stderr).to.equal('message\n'))
  .it('writes to stderr')

  fancy
  .stdout()
  .do(async () => {
    class Test extends Command {
        async run() {
          this.telemetryEnabled = true
          this.trackEvent('event')
          this.log('No crash')
        }
      }

    return Test.run([])
  })
  .do(output => expect(output.stdout).to.equal('No crash\n'))
  .it('Track Event should not crash')

  fancy
  .stdin('test reading of piped data')
  .stdout()
  .do(async () => {
    try {
      const resp = await ReadPipedStdin.read()
      if (resp) console.log(resp)
    } catch (error) {
      if (error) console.log(`Error: ${error}`)
    }
  })
  .do(output => expect(output.stdout).to.equal('test reading of piped data\n'))
  .it('should read and echo the stdin input')

})