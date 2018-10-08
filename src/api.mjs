import {
  CreateRealm,
  SetRealmGlobalObject,
  SetDefaultGlobalBindings,
} from './realm.mjs';
import {
  ExecutionContext,
  ScriptEvaluation,
  surroundingAgent,
} from './engine.mjs';
import { Value, Descriptor, Type } from './value.mjs';
import { ParseScript } from './parse.mjs';
import {
  Completion,
  NormalCompletion,
  ThrowCompletion,
  AbruptCompletion,
} from './completion.mjs';
import * as AbstractOps from './abstract-ops/all.mjs';

export const Abstract = { ...AbstractOps, Type };
const { ObjectCreate, CreateBuiltinFunction } = Abstract;
export {
  AbruptCompletion,
  NormalCompletion,
  Completion,
  Descriptor,
};

class APIRealm {
  constructor(options = {}) {
    const realm = CreateRealm();

    realm.hostDefinedOptions = options;

    const newContext = new ExecutionContext();
    newContext.Function = Value.null;
    newContext.Realm = realm;
    newContext.ScriptOrModule = Value.null;
    surroundingAgent.executionContextStack.push(newContext);
    const global = Value.undefined;
    const thisValue = Value.undefined;
    SetRealmGlobalObject(realm, global, thisValue);
    this.global = SetDefaultGlobalBindings(realm);

    surroundingAgent.executionContextStack.pop();

    this.realm = realm;
    this.context = newContext;
    this.agent = surroundingAgent;
  }

  evaluateScript(sourceText) {
    surroundingAgent.executionContextStack.push(this.context);

    const callerContext = surroundingAgent.runningExecutionContext;
    const callerRealm = callerContext.Realm;
    const callerScriptOrModule = callerContext.ScriptOrModule;

    const newContext = new ExecutionContext();
    newContext.Function = Value.null;
    newContext.Realm = callerRealm;
    newContext.ScriptOrModule = callerScriptOrModule;

    surroundingAgent.executionContextStack.push(newContext);

    const realm = this.realm;
    const s = ParseScript(sourceText, realm, undefined);
    if (Array.isArray(s)) {
      return new ThrowCompletion(s[0]);
    }
    const res = ScriptEvaluation(s);

    while (true) { // eslint-disable-line no-constant-condition
      const nextQueue = surroundingAgent.jobQueue;
      if (nextQueue.length === 0) {
        break;
      }
      const nextPending = nextQueue.shift();
      const newContext = new ExecutionContext(); // eslint-disable-line no-shadow
      newContext.Function = Value.null;
      newContext.Realm = nextPending.Realm;
      newContext.ScriptOrModule = nextPending.ScriptOrModule;
      surroundingAgent.executionContextStack.push(newContext);
      const result = nextPending.Job(...nextPending.Arguments);
      surroundingAgent.executionContextStack.pop();
      if (result instanceof AbruptCompletion) {
        return result;
      }
    }

    surroundingAgent.executionContextStack.pop();
    surroundingAgent.executionContextStack.pop();

    return res;
  }
}

function APIObject(realm, intrinsic = '%ObjectPrototype%') {
  return ObjectCreate(realm.realm.Intrinsics[intrinsic]);
}

class APIValue extends Value {
  constructor(realm, value) {
    if (typeof value === 'function') {
      return CreateBuiltinFunction(value, [], realm.realm);
    }
    if (value === undefined) {
      return Value.undefined;
    }
    if (value === null) {
      return Value.null;
    }
    if (value === true) {
      return Value.true;
    }
    if (value === false) {
      return Value.false;
    }
    return new Value(value);
  }
}

export {
  APIRealm as Realm,
  APIValue as Value,
  APIObject as Object,
};
