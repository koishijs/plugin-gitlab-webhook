import { Context, onStart, onStop } from 'koishi-core'
import { Server, createServer } from 'http'
import WebhookHandler from 'node-gitlab-webhook'
import * as Interfaces from 'node-gitlab-webhook/interfaces'

declare module 'koishi-core/dist/app' {
  export interface AppOptions {
    gitlabWebhook?: WebhookConfig
  }
}

export interface WebhookConfig {
  port?: number
  secret?: string
  path?: string
}

export const webhooks: Record<string, Interfaces.Handler & Interfaces.GitLabHooks> = {}
export const servers: Record<number, Server> = {}

const defaultOptions: WebhookConfig = {
  port: 12140,
  secret: '',
  path: '/',
}

interface RepositoryPayload {
  project: Interfaces.Project
}

export const name = 'gitlab-webhook'

export function apply (ctx: Context, options: Record<string, number[]> = {}) {
  ctx = ctx.intersect(ctx.app.groups)

  const config = ctx.app.options.gitlabWebhook = {
    ...defaultOptions,
    ...ctx.app.options.gitlabWebhook,
  }

  const key = config.path + config.secret + config.port
  if (!webhooks[key]) {
    webhooks[key] = WebhookHandler(config as Interfaces.Option)
  }
  const webhook = webhooks[key]

  if (!servers[config.port]) {
    const server = servers[config.port] = createServer(webhooks[key])
    onStart(() => server.listen(config.port))
    onStop(() => server.close())
  }

  function wrapHandler <T extends RepositoryPayload> (handler: (event: T) => void | string | Promise<void | string>) {
    return async (event: Interfaces.EventData<T>) => {
      const { project } = event.payload
      const groups = options[project.path_with_namespace]
      if (!groups) return

      const message = await handler(event.payload)
      if (!message) return
      for (const id of groups) {
        await ctx.sender.sendGroupMsgAsync(id, message)
      }
    }
  }

  webhook.on('push', wrapHandler<Interfaces.PushEvent>(({ user_name, commits, project, ref, after }) => {
    // do not show pull request merge
    if (/^0+$/.test(after)) return

    return [
      `[GitLab] Push (${project.path_with_namespace})`,
      `Ref: ${ref}`,
      `User: ${user_name}`,
      ...commits.map(c => c.message.replace(/\n\s*\n/g, '\n')),
    ].join('\n')
  }))

  webhook.on('tag_push', wrapHandler<Interfaces.TagPushEvent>(({ project, ref }) => {
    return `[GitLab] ${project.path_with_namespace} published tag ${ref.slice(10)}`
  }))

  webhook.on('issue', wrapHandler<Interfaces.IssueEvent>(({ user, project, object_attributes }) => {
    switch (object_attributes.action) {
      case 'open':
        return [
          `[GitLab] Issue Opened (${project.path_with_namespace}#${object_attributes.iid})`,
          `Title: ${object_attributes.title}`,
          `User: ${user.name}`,
          `URL: ${object_attributes.url}`,
          object_attributes.description.replace(/\n\s*\n/g, '\n'),
        ].join('\n')
    }
  }))

  webhook.on('note', wrapHandler<Interfaces.NoteEvent>(({ user, project, object_attributes, merge_request, issue }) => {
    switch (object_attributes.noteable_type) {
      case 'Commit':
        return [
          `[GitLab] Commit Comment (${project.path_with_namespace})`,
          `User: ${user.name}`,
          `URL: ${object_attributes.url}`,
          object_attributes.note.replace(/\n\s*\n/g, '\n'),
        ].join('\n')
      case 'MergeRequest':
        return [
          `[GitLab] Merge Request Comment (${project.path_with_namespace}#${merge_request.iid})`,
          `User: ${user.name}`,
          `URL: ${object_attributes.url}`,
          object_attributes.note.replace(/\n\s*\n/g, '\n'),
        ].join('\n')
      case 'Issue':
        return [
          `[GitLab] Issue Comment (${project.path_with_namespace}#${issue.iid})`,
          `User: ${user.name}`,
          `URL: ${object_attributes.url}`,
          object_attributes.note.replace(/\n\s*\n/g, '\n'),
        ].join('\n')
    }
  }))

  webhook.on('merge_request', wrapHandler<Interfaces.MergeRequestEvent>(({ user, project, object_attributes }) => {
    switch (object_attributes.action) {
      case 'open':
        return [
          `[GitLab] Pull Request Opened (${project.path_with_namespace}#${object_attributes.iid})`,
          `${object_attributes.target.path_with_namespace}/${object_attributes.target_branch} <- ${object_attributes.source.path_with_namespace}/${object_attributes.source_branch}`,
          `User: ${user.name}`,
          `URL: ${object_attributes.url}`,
          object_attributes.title.replace(/\n\s*\n/g, '\n'),
        ].join('\n')
    }
  }))
}
