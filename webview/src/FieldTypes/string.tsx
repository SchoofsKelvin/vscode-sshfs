import * as React from 'react';
import { FieldBase } from './base';

export class FieldString extends FieldBase<string | undefined> {
    public getInitialSubState({ value }: FieldString['props']): FieldString['state'] {
        value = value || undefined;
        return { oldValue: value, newValue: value };
    }
    public renderInput() {
        return <input value={this.state.newValue || ''} onChange={this.onChangeEvent} />;
    }
    public onChangeEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.onChange(event.target.value || undefined);
    }
}