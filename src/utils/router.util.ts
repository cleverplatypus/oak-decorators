import { Reflect, Router, bootstrap } from '../deps.ts';

import {
  INJECTOR_INTERFACES_METADATA,
  MIDDLEWARE_METADATA,
  MODULE_METADATA,
} from '../const.ts';
import { CreateRouterOption } from '../interfaces/mod.ts';
import { RouterContext, Next } from 'oak';
import { ParamData } from '../interfaces/mod.ts';
import { RouteArgsMetadata } from '../interfaces/mod.ts';
import { ROUTE_ARGS_METADATA } from '../const.ts';
import { RouteParamtypes } from '../enums/mod.ts';
import { ClassConstructor } from '../types.ts';
import { CONTROLLER_METADATA } from '../const.ts';

export const isUndefined = (obj: any): obj is undefined =>
  typeof obj === 'undefined';
export const isString = (fn: any): fn is string => typeof fn === 'string';
export const isNil = (obj: any): obj is null | undefined =>
  isUndefined(obj) || obj === null;

const isProviderSuitable = (
  provider: ClassConstructor,
  requiredProvider: ClassConstructor | null,
  injectable: symbol | string | ClassConstructor | null
): boolean => {
  const implementingInterfaces =
    Reflect.getMetadata(INJECTOR_INTERFACES_METADATA, provider) || [];
  const isRequiredProvider =
    requiredProvider &&
    (provider === requiredProvider ||
      Object.prototype.isPrototypeOf.call(
        provider.prototype,
        requiredProvider.prototype
      ));
  const isInjectableMatch =
    provider === injectable || implementingInterfaces.includes(injectable);

  return isRequiredProvider || isInjectableMatch;
};

const findProviderForRequirement = (
  providers: ClassConstructor[],
  requiredProvider: ClassConstructor | null,
  injectable: symbol | string | ClassConstructor | null,
  Controller: ClassConstructor
): ClassConstructor => {
  const provider = providers.find((provider) =>
    isProviderSuitable(provider, requiredProvider, injectable)
  );

  if (!provider) {
    throw new Error(
      `Provider of type ${
        requiredProvider?.name || String(injectable)
      } not found for ${Object.getPrototypeOf(Controller).name}`
    );
  }

  return provider;
};

const mapInjectables = (
  requirements: Array<ClassConstructor | null>,
  injectables: Array<symbol | string | ClassConstructor | null>,
  providers: ClassConstructor[],
  Controller: ClassConstructor
): ClassConstructor[] => {
  return requirements.map((requiredProvider, idx) => {
    return findProviderForRequirement(
      providers,
      requiredProvider,
      injectables[idx],
      Controller
    );
  });
};

const createRouter = (
  { controllers, providers = [], routePrefix }: CreateRouterOption,
  prefix?: string,
  router = new Router()
) => {
  controllers.forEach((Controller) => {
    let requiredProviders;
    const arity = Object.getPrototypeOf(Controller).length;
    const requiredProvidersFromMetadata =
      Reflect.getMetadata(
        'design:paramtypes',
        Object.getPrototypeOf(Controller)
      ) || [];
    const { injectables } = Reflect.getMetadata(
      CONTROLLER_METADATA,
      Controller
    ) || { injectables: [] };

    if (!requiredProvidersFromMetadata?.length && arity) {
      //looks like metadata emission is not available
      if (injectables.length < arity) {
        throw new Error(
          `Cannot find injectable for ${Object.getPrototypeOf(Controller).name}`
        );
      }
      //passing a null-filled array will force looking for explicit injectables
      requiredProviders = mapInjectables(
        Array.from({ length: arity }, (_, i) => null),
        injectables,
        providers,
        Controller
      );
    } else {
      requiredProviders = mapInjectables(
        requiredProvidersFromMetadata,
        injectables,
        providers,
        Controller
      );
    }
    Reflect.defineMetadata('design:paramtypes', requiredProviders, Controller);

    const controller = bootstrap<any>(Controller);
    const prefixFull = prefix
      ? prefix + (routePrefix ? `/${routePrefix}` : '')
      : routePrefix;
    controller.init(prefixFull);
    const path = controller.path;
    const route = controller.route;
    router.use(path, route.routes(), route.allowedMethods());
  });
  return router;
};

const getRouter = (module: any, prefix?: string, router?: Router) => {
  const mainModuleOption: CreateRouterOption = Reflect.getMetadata(
    MODULE_METADATA,
    module.prototype
  );

  const newRouter = createRouter(mainModuleOption, prefix, router);

  mainModuleOption.modules?.map((module) =>
    getRouter(module, mainModuleOption.routePrefix, newRouter)
  ) || [];

  return newRouter;
};

export const assignModule = (module: any) => {
  const router = getRouter(module);
  return router.routes();
};

/**
 * Registers a decorator that can be added to a controller's
 * method. The handler will be called at runtime when the
 * endpoint method is invoked with the Context and Next parameters.
 *
 * @param target decorator's target
 * @param methodName decorator's method name
 * @param handler decorator's handler
 */
export const registerMiddlewareMethodDecorator = (
  target: ClassConstructor,
  methodName: string,
  handler: (ctx: RouterContext, next: Next) => void
) => {
  const middleware =
    Reflect.getMetadata(MIDDLEWARE_METADATA, target, methodName) || [];
  middleware.push(handler);
  Reflect.defineMetadata(MIDDLEWARE_METADATA, middleware, target, methodName);
};

/**
 * Registers a custom route parameter decorator.
 *
 * @param {ClassConstructor} target - the target object
 * @param {string} methodName - the name of the method
 * @param {number} paramIndex - the index of the parameter
 * @return {(data?: ParamData) => (handler: (ctx: RouterContext<string>) => void) => void} a function that takes optional data and returns a function that requires the param's handler as only parameter
 */
export const registerCustomRouteParamDecorator = (
  target: ClassConstructor,
  methodName: string,
  paramIndex: number
) => {
  return (data?: ParamData) =>
    (handler: (ctx: RouterContext<string>) => void) => {
      const args: RouteArgsMetadata[] =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, target, methodName) || [];
      const hasParamData = isNil(data) || isString(data);
      const paramData = hasParamData ? data : undefined;

      args.push({
        paramtype: RouteParamtypes.CUSTOM,
        index: paramIndex,
        data: paramData,
        handler,
      });

      Reflect.defineMetadata(ROUTE_ARGS_METADATA, args, target, methodName);
    };
};
