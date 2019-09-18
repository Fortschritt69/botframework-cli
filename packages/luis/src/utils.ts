import {CLIError} from '@microsoft/bf-cli-command'
import {existsSync} from 'fs'
import {basename, dirname, extname, isAbsolute, join} from 'path'

export namespace Utils {
  export function validatePath(outputPath: string, workingDirectory: string, defaultFileName: string): string {
    let completePath = isAbsolute(outputPath) ? outputPath : join(workingDirectory, outputPath)
    const containingDir = dirname(completePath)

    // If the cointaining folder doesnt exist
    if (!existsSync(containingDir)) throw new CLIError("Path doesn't exist")

    const baseElement = basename(completePath)
    const pathAlreadyExist = existsSync(completePath)

    // If the last element in the path is a file
    if (baseElement.includes('.')) {
      return pathAlreadyExist ? enumerateFileName(completePath) : completePath
    } else { // If the last element in the path is a folder
      if (!pathAlreadyExist) throw new CLIError("Path doesn't exist")
      return join(completePath, defaultFileName)
    }
  }

  function enumerateFileName(filePath: string): string {
    const fileName = basename(filePath)
    const containingDir = dirname(filePath)

    if (!existsSync(containingDir)) throw new CLIError("Path doesn't exist")

    const extension = extname(fileName)
    const baseName = basename(fileName, extension)
    let nextNumber = 0
    let newPath = ''

    do {
      newPath = join(containingDir, baseName + `(${++nextNumber})` + extension)
    } while (existsSync(newPath))

    return newPath
  }
}
