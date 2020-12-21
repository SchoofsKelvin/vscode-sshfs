import * as React from 'react';
import { promptPath } from '../vscode';
import { FieldBase } from './base';

export class FieldPath extends FieldBase<string | undefined> {
    public renderInput() {
        return <div className="FieldPath">
            <button onClick={this.prompt}>Prompt</button>
            <input value={this.state.newValue || ''} onChange={this.onChangeEvent} />
        </div>;
    }
    public onChangeEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.onChange(event.target.value || undefined);
    }
    public prompt = async () => {
        try {
            this.onChange(await promptPath());
        } catch (e) {
            console.log('Error while prompting file path', e);
        }
    };
}

