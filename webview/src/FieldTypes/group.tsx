import * as React from 'react';
import { FieldBase } from './base';

const CONTEXT = React.createContext<FieldGroup | undefined>(undefined);

export class FieldGroup<T = any> extends React.Component {
    public static Consumer = CONTEXT.Consumer;
    protected static CONTEXT = CONTEXT;
    protected fields: FieldBase<T>[] = [];
    public register(field: FieldBase<T>) {
        this.fields.push(field);
    }
    public getErrors(): string[] {
        return this.fields.map(f => f.getError()).filter(e => e) as string[];;
    }
    public mapValues(): { [key: string]: T } {
        const res = {} as any;
        this.fields.forEach(f => res[f.getLabel()] = f.getValue());
        return res;
    }
    public render() {
        this.fields = [];
        return <CONTEXT.Provider value={this}>{this.props.children}</CONTEXT.Provider>
    }
}
