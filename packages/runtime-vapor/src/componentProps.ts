import { EMPTY_ARR, NO, YES, camelize, hasOwn, isFunction } from '@vue/shared'
import type { VaporComponent, VaporComponentInstance } from './component'
import {
  type NormalizedPropsOptions,
  baseNormalizePropsOptions,
  isEmitListener,
  popWarningContext,
  pushWarningContext,
  resolvePropValue,
  validateProps,
} from '@vue/runtime-dom'
import { normalizeEmitsOptions } from './componentEmits'
import { renderEffect } from './renderEffect'

export type RawProps = Record<string, () => unknown> & {
  // generated by compiler for :[key]="x" or v-bind="x"
  $?: DynamicPropsSource[]
}

type DynamicPropsSource =
  | (() => Record<string, unknown>)
  | Record<string, () => unknown>

// TODO optimization: maybe convert functions into computeds
export function resolveSource(
  source: Record<string, any> | (() => Record<string, any>),
): Record<string, any> {
  return isFunction(source) ? source() : source
}

export function getPropsProxyHandlers(
  comp: VaporComponent,
): [
  ProxyHandler<VaporComponentInstance> | null,
  ProxyHandler<VaporComponentInstance>,
] {
  if (comp.__propsHandlers) {
    return comp.__propsHandlers
  }
  const propsOptions = normalizePropsOptions(comp)[0]
  const emitsOptions = normalizeEmitsOptions(comp)
  const isProp = propsOptions ? (key: string) => hasOwn(propsOptions, key) : NO
  const isAttr = propsOptions
    ? (key: string) =>
        key !== '$' && !isProp(key) && !isEmitListener(emitsOptions, key)
    : YES

  const getProp = (instance: VaporComponentInstance, key: string) => {
    if (key === '$' || !isProp(key)) {
      return
    }
    const rawProps = instance.rawProps
    const dynamicSources = rawProps.$
    if (dynamicSources) {
      let i = dynamicSources.length
      let source, isDynamic, rawKey
      while (i--) {
        source = dynamicSources[i]
        isDynamic = isFunction(source)
        source = isDynamic ? (source as Function)() : source
        for (rawKey in source) {
          if (camelize(rawKey) === key) {
            return resolvePropValue(
              propsOptions!,
              key,
              isDynamic ? source[rawKey] : source[rawKey](),
              instance,
              resolveDefault,
            )
          }
        }
      }
    }
    for (const rawKey in rawProps) {
      if (camelize(rawKey) === key) {
        return resolvePropValue(
          propsOptions!,
          key,
          rawProps[rawKey](),
          instance,
          resolveDefault,
        )
      }
    }
    return resolvePropValue(
      propsOptions!,
      key,
      undefined,
      instance,
      resolveDefault,
    )
  }

  const propsHandlers = propsOptions
    ? ({
        get: (target, key: string) => getProp(target, key),
        has: (_, key: string) => isProp(key),
        getOwnPropertyDescriptor(target, key: string) {
          if (isProp(key)) {
            return {
              configurable: true,
              enumerable: true,
              get: () => getProp(target, key),
            }
          }
        },
        ownKeys: () => Object.keys(propsOptions),
        set: NO,
        deleteProperty: NO,
      } satisfies ProxyHandler<VaporComponentInstance>)
    : null

  const getAttr = (target: RawProps, key: string) => {
    if (isProp(key) || isEmitListener(emitsOptions, key)) {
      return
    }
    const dynamicSources = target.$
    if (dynamicSources) {
      let i = dynamicSources.length
      let source, isDynamic
      while (i--) {
        source = dynamicSources[i]
        isDynamic = isFunction(source)
        source = isDynamic ? (source as Function)() : source
        if (hasOwn(source, key)) {
          return isDynamic ? source[key] : source[key]()
        }
      }
    }
    if (hasOwn(target, key)) {
      return target[key]
    }
  }

  const hasAttr = (target: RawProps, key: string) => {
    if (isAttr(key)) {
      const dynamicSources = target.$
      if (dynamicSources) {
        let i = dynamicSources.length
        while (i--) {
          if (hasOwn(resolveSource(dynamicSources[i]), key)) {
            return true
          }
        }
      }
      return hasOwn(target, key)
    } else {
      return false
    }
  }

  const attrsHandlers = {
    get: (target, key: string) => getAttr(target.rawProps, key),
    has: (target, key: string) => hasAttr(target.rawProps, key),
    getOwnPropertyDescriptor(target, key: string) {
      if (hasAttr(target.rawProps, key)) {
        return {
          configurable: true,
          enumerable: true,
          get: () => getAttr(target.rawProps, key),
        }
      }
    },
    ownKeys(target) {
      const rawProps = target.rawProps
      const keys: string[] = []
      for (const key in rawProps) {
        if (isAttr(key)) keys.push(key)
      }
      const dynamicSources = rawProps.$
      if (dynamicSources) {
        let i = dynamicSources.length
        let source
        while (i--) {
          source = resolveSource(dynamicSources[i])
          for (const key in source) {
            if (isAttr(key)) keys.push(key)
          }
        }
      }
      return Array.from(new Set(keys))
    },
    set: NO,
    deleteProperty: NO,
  } satisfies ProxyHandler<VaporComponentInstance>

  return (comp.__propsHandlers = [propsHandlers, attrsHandlers])
}

export function normalizePropsOptions(
  comp: VaporComponent,
): NormalizedPropsOptions {
  const cached = comp.__propsOptions
  if (cached) return cached

  const raw = comp.props
  if (!raw) return EMPTY_ARR as []

  const normalized: NormalizedPropsOptions[0] = {}
  const needCastKeys: NormalizedPropsOptions[1] = []
  baseNormalizePropsOptions(raw, normalized, needCastKeys)

  return (comp.__propsOptions = [normalized, needCastKeys])
}

function resolveDefault(
  factory: (props: Record<string, any>) => unknown,
  instance: VaporComponentInstance,
) {
  return factory.call(null, instance.props)
}

export function hasFallthroughAttrs(
  comp: VaporComponent,
  rawProps: RawProps | undefined,
): boolean {
  if (rawProps) {
    // determine fallthrough
    if (rawProps.$ || !comp.props) {
      return true
    } else {
      // check if rawProps contains any keys not declared
      const propsOptions = normalizePropsOptions(comp)[0]
      for (const key in rawProps) {
        if (!hasOwn(propsOptions!, key)) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * dev only
 */
export function setupPropsValidation(instance: VaporComponentInstance): void {
  const rawProps = instance.rawProps
  if (!rawProps) return
  renderEffect(() => {
    pushWarningContext(instance)
    validateProps(
      resolveDynamicProps(rawProps),
      instance.props,
      normalizePropsOptions(instance.type)[0]!,
    )
    popWarningContext()
  }, true /* noLifecycle */)
}

export function resolveDynamicProps(props: RawProps): Record<string, unknown> {
  const mergedRawProps: Record<string, any> = {}
  for (const key in props) {
    if (key !== '$') {
      mergedRawProps[key] = props[key]()
    }
  }
  if (props.$) {
    for (const source of props.$) {
      const isDynamic = isFunction(source)
      const resolved = isDynamic ? source() : source
      for (const key in resolved) {
        mergedRawProps[key] = isDynamic
          ? resolved[key]
          : (resolved[key] as Function)()
      }
    }
  }
  return mergedRawProps
}
