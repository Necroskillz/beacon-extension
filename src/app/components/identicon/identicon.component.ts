import { Component, Input } from '@angular/core'
import { createIcon } from '@download/blockies'
import { BigNumber } from 'bignumber.js'
import { toDataUrl } from 'myetherwallet-blockies'

@Component({
  selector: 'identicon',
  templateUrl: 'identicon.component.html',
  styleUrls: ['./identicon.component.scss']
})
export class IdenticonComponent {
  // used in template
  public identicon

  @Input()
  set address(value: string) {
    if (!value) {
      return
    }
    if (value.startsWith('ak_')) {
      this.identicon = createIcon({ seed: value }).toDataURL()
    } else if (value.startsWith('tz') || value.startsWith('kt')) {
      this.identicon = createIcon({
        seed: `0${this.b582int(value)}`,
        spotcolor: '#000'
      }).toDataURL()
    } else {
      this.identicon = toDataUrl(value.toLowerCase())
    }
  }

  private b582int(v) {
    let rv = new BigNumber(0)
    const alpha = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    for (let i = 0; i < v.length; i++) {
      rv = rv.plus(
        new BigNumber(alpha.indexOf(v[v.length - 1 - i])).multipliedBy(new BigNumber(alpha.length).exponentiatedBy(i))
      )
    }

    return rv.toString(16)
  }
}
